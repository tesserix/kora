// Package coach builds the deterministic, real-numbers-only context that
// grounds the coach's nudges and Q&A: today's dashboard summary, a recent
// (7-day) trend, and the user's usual foods. It also derives the
// guardrails.Signals the Protective policy evaluates candidate nudges
// against. Nothing in this package calls an LLM or invents data — every
// value traces back to a repository read.
package coach

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/tracking"
)

// recentWindowDays is the trailing window (inclusive of today) used to
// compute averages, logging cadence, and the fasting streak.
const recentWindowDays = 7

// weightWindowDays is the trailing window used for the weight trend. It is
// deliberately longer than recentWindowDays: a 7-day weight delta is mostly
// water-weight noise, so the trend is stated over a month.
const weightWindowDays = 30

// Fact is one grounding data point suitable for citing in a coach response.
type Fact struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// DailyTotal is one local calendar day's aggregated intake within the
// recent window. Days with no logs are zero-valued, not omitted, so
// RecentDaily always has exactly recentWindowDays entries.
type DailyTotal struct {
	Day      time.Time
	Kcal     float64
	ProteinG float64
	FiberG   float64
	LogCount int
}

// Context is the grounded, deterministic snapshot of a user's state that
// the coach's prompts and Q&A are built from.
type Context struct {
	Today             dashboard.Summary
	RecentDaily       []DailyTotal // oldest -> newest, len == recentWindowDays
	AvgIntakeKcal     float64
	AvgProteinG       float64
	LogsPerDay        float64
	DaysLogged        int
	FastingStreakDays int
	Usual             memory.Memory
	WeightTrend       WeightTrend
}

// WeightTrend is the observed change in logged weight across the trailing
// weightWindowDays. DeltaKg is signed: negative means weight went down.
// Valid is false when there are too few entries to state a trend at all —
// callers must not present an invalid trend as a zero change. Days can be 0
// even when Valid is true: it is an elapsed-hours/24 truncation, so two
// entries inside the same 24h window produce Days: 0. Future consumers must
// guard against this before using Days as a rate denominator (e.g.
// DeltaKg/Days), or a division by zero / inflated rate results.
type WeightTrend struct {
	DeltaKg float64
	Days    int
	Valid   bool
}

// LogSource is the read used to aggregate RecentDaily. foodlog.Repository
// satisfies it; tests can supply a fake.
type LogSource interface {
	ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error)
}

// WeightSource is the read used to compute WeightTrend.
// tracking.Repository satisfies it; tests can supply a fake.
type WeightSource interface {
	WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]tracking.WeightEntry, error)
}

// Grounder wires the read-only sources BuildContext aggregates.
type Grounder struct {
	Dash    dashboard.Service
	Logs    LogSource
	Mem     memory.Service
	Weights WeightSource
}

// NewGrounder constructs a Grounder from its concrete dependencies.
func NewGrounder(dash dashboard.Service, logs LogSource, mem memory.Service, weights WeightSource) Grounder {
	return Grounder{Dash: dash, Logs: logs, Mem: mem, Weights: weights}
}

// BuildContext assembles a Context: today's dashboard summary, the last
// recentWindowDays aggregated per local day, and the user's usual foods.
func (g Grounder) BuildContext(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (Context, error) {
	if loc == nil {
		loc = time.UTC
	}

	today, err := g.Dash.ForDay(ctx, userID, now, loc)
	if err != nil {
		return Context{}, fmt.Errorf("coach: build context: today summary: %w", err)
	}

	since := windowStart(now, loc)
	logs, err := g.Logs.ListForUserSince(ctx, userID, since)
	if err != nil {
		return Context{}, fmt.Errorf("coach: build context: recent logs: %w", err)
	}
	recentDaily := aggregateDaily(logs, since)

	usual, err := g.Mem.Build(ctx, userID, now, loc)
	if err != nil {
		return Context{}, fmt.Errorf("coach: build context: usual foods: %w", err)
	}

	weightFrom := windowStartDays(now, loc, weightWindowDays)
	weightTrend := WeightTrend{}
	if g.Weights != nil {
		entries, err := g.Weights.WeightSeries(ctx, userID, weightFrom, now)
		if err == nil {
			weightTrend = weightTrendFrom(entries)
		} else {
			// Best-effort: the weight trend is additive grounding, not a
			// hard dependency, so BuildContext must still succeed with
			// WeightTrend left invalid. Log the failure so it isn't
			// silently swallowed.
			slog.WarnContext(ctx, "coach: weight trend read failed, omitting trend",
				"error", err, "user_id", userID)
		}
	}

	avgKcal, avgProtein, logsPerDay, daysLogged := summarizeRecent(recentDaily)

	return Context{
		Today:             today,
		RecentDaily:       recentDaily,
		AvgIntakeKcal:     avgKcal,
		AvgProteinG:       avgProtein,
		LogsPerDay:        logsPerDay,
		DaysLogged:        daysLogged,
		FastingStreakDays: fastingStreak(recentDaily),
		Usual:             usual,
		WeightTrend:       weightTrend,
	}, nil
}

// windowStart returns the local-midnight (in loc) start of the trailing
// recentWindowDays window ending on now's local calendar day. Both the DB
// fetch (ListForUserSince) and aggregateDaily's bucketing MUST use this same
// boundary — if they diverge, the oldest day in the window silently drops
// logs whenever now's clock-time/Location differs from loc (see
// coach.BuildContext's `now = time.Now().UTC()` + user-loc call pattern).
func windowStart(now time.Time, loc *time.Location) time.Time {
	return windowStartDays(now, loc, recentWindowDays)
}

// windowStartDays returns the local-midnight (in loc) start of the trailing
// days-long window ending on now's local calendar day.
func windowStartDays(now time.Time, loc *time.Location, days int) time.Time {
	nowLocal := now.In(loc)
	return time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc).
		AddDate(0, 0, -(days - 1))
}

// weightTrendFrom derives a WeightTrend from entries. Fewer than two
// entries is not a trend, so it reports Valid: false rather than a
// misleading zero delta. The caller's WeightSeries read is expected to be
// ascending by LoggedAt, but this does not trust that ordering: it picks
// the earliest and latest entries by LoggedAt explicitly, so an
// out-of-order or unsorted result still yields a correct delta and span
// rather than a silently wrong one.
func weightTrendFrom(entries []tracking.WeightEntry) WeightTrend {
	if len(entries) < 2 {
		return WeightTrend{}
	}
	first, last := entries[0], entries[0]
	for _, e := range entries[1:] {
		if e.LoggedAt.Before(first.LoggedAt) {
			first = e
		}
		if e.LoggedAt.After(last.LoggedAt) {
			last = e
		}
	}
	days := int(last.LoggedAt.Sub(first.LoggedAt).Hours() / 24)
	return WeightTrend{
		DeltaKg: last.WeightKg - first.WeightKg,
		Days:    days,
		Valid:   true,
	}
}

// aggregateDaily buckets logs into local calendar days spanning
// [since, since+recentWindowDays-1], oldest first. Days with no logs are
// present in the result, zero-valued. since must be the local-midnight start
// produced by windowStart so bucketing lines up with the DB fetch boundary.
func aggregateDaily(logs []foodlog.FoodLog, since time.Time) []DailyTotal {
	loc := since.Location()
	out := make([]DailyTotal, recentWindowDays)
	index := make(map[string]int, recentWindowDays)
	for i := 0; i < recentWindowDays; i++ {
		d := since.AddDate(0, 0, i)
		out[i] = DailyTotal{Day: d}
		index[d.Format("2006-01-02")] = i
	}

	for _, l := range logs {
		key := l.LoggedAt.In(loc).Format("2006-01-02")
		i, ok := index[key]
		if !ok {
			continue // outside the window (defensive; since already filters this)
		}
		out[i].Kcal += l.Kcal
		out[i].ProteinG += l.ProteinG
		out[i].FiberG += l.FiberG
		out[i].LogCount++
	}
	return out
}

// summarizeRecent computes the window averages (denominator ==
// recentWindowDays, so zero-log days pull the average down, matching "avg
// intake over the last 7 days") plus the count of days that had >=1 log.
func summarizeRecent(daily []DailyTotal) (avgKcal, avgProtein, logsPerDay float64, daysLogged int) {
	n := len(daily)
	if n == 0 {
		return 0, 0, 0, 0
	}
	var sumKcal, sumProtein float64
	var totalLogs int
	for _, d := range daily {
		sumKcal += d.Kcal
		sumProtein += d.ProteinG
		totalLogs += d.LogCount
		if d.LogCount > 0 {
			daysLogged++
		}
	}
	nf := float64(n)
	return sumKcal / nf, sumProtein / nf, float64(totalLogs) / nf, daysLogged
}

// fastingStreak counts consecutive zero-intake days ending YESTERDAY, and
// only within the span in which the user was actually logging.
//
// Two rules, both deliberate:
//
//   - Today is excluded. It is always incomplete — before the day's first
//     meal it looks identical to a fast — so counting it would make this
//     signal, and every risk decision derived from it, depend on the time
//     of day the request happened to arrive.
//   - Days before the user's first log in the window do not count. A day
//     with no logs is absent data, not evidence of not eating. Without this,
//     a brand-new user's seven empty days read as a seven-day fast and trip
//     the ED-risk threshold on first use. guardrails.AtRisk already applies
//     exactly this reasoning to AvgIntakeKcal ("zero means no data"); this
//     restores the symmetry.
//
// A day the user logged on that still totals zero kcal DOES count — that is
// a real zero-intake day, not missing data.
//
// The effect is a strictly less sensitive signal. That is the point: a flag
// that fires for every user carries no information. A genuine gap after
// established logging still fires.
func fastingStreak(daily []DailyTotal) int {
	// Exclude today (the last entry): it is incomplete.
	if len(daily) < 2 {
		return 0
	}
	complete := daily[:len(daily)-1]

	// Find the first day the user logged anything. Everything before it is
	// absent data rather than observed behaviour.
	firstLogged := -1
	for i, d := range complete {
		if d.LogCount > 0 {
			firstLogged = i
			break
		}
	}
	if firstLogged < 0 {
		return 0
	}

	streak := 0
	for i := len(complete) - 1; i >= firstLogged; i-- {
		if complete[i].Kcal > 0 {
			break
		}
		streak++
	}
	return streak
}

// Render is a compact, deterministic text block for the LLM prompt. It
// cites only real, already-computed numbers.
func (c Context) Render() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Today: %s/%s kcal, protein %s/%sg, fibre %sg.",
		fmtNum(c.Today.Consumed.Kcal), fmtNum(c.Today.Targets.Kcal),
		fmtNum(c.Today.Consumed.ProteinG), fmtNum(c.Today.Targets.ProteinG),
		fmtNum(c.Today.Consumed.FiberG))
	fmt.Fprintf(&b, " %dd avg intake %s kcal over %d logged days.",
		recentWindowDays, fmtNum(c.AvgIntakeKcal), c.DaysLogged)
	if foods := usualFoodsText(c.Usual); foods != "" {
		fmt.Fprintf(&b, " Usual foods: %s.", foods)
	}
	return b.String()
}

// Facts returns structured label/value citations for the same figures
// Render describes in prose.
func (c Context) Facts() []Fact {
	return []Fact{
		{Label: "today_kcal_consumed", Value: fmtNum(c.Today.Consumed.Kcal)},
		{Label: "today_kcal_target", Value: fmtNum(c.Today.Targets.Kcal)},
		{Label: "today_protein_g_consumed", Value: fmtNum(c.Today.Consumed.ProteinG)},
		{Label: "today_protein_g_target", Value: fmtNum(c.Today.Targets.ProteinG)},
		{Label: "today_fiber_g", Value: fmtNum(c.Today.Consumed.FiberG)},
		{Label: fmt.Sprintf("avg_intake_kcal_%dd", recentWindowDays), Value: fmtNum(c.AvgIntakeKcal)},
		{Label: fmt.Sprintf("avg_protein_g_%dd", recentWindowDays), Value: fmtNum(c.AvgProteinG)},
		{Label: fmt.Sprintf("logs_per_day_%dd", recentWindowDays), Value: fmtNum(c.LogsPerDay)},
		{Label: fmt.Sprintf("days_logged_%dd", recentWindowDays), Value: strconv.Itoa(c.DaysLogged)},
		{Label: "fasting_streak_days", Value: strconv.Itoa(c.FastingStreakDays)},
	}
}

const usualFoodsCiteLimit = 3

// usualFoodsText names the user's most habitual foods (frequent, falling
// back to recents when nothing has repeated yet), for the prose grounding.
func usualFoodsText(m memory.Memory) string {
	items := m.Frequent
	if len(items) == 0 {
		items = m.Recents
	}
	if len(items) == 0 {
		return ""
	}
	limit := usualFoodsCiteLimit
	if len(items) < limit {
		limit = len(items)
	}
	names := make([]string, limit)
	for i := 0; i < limit; i++ {
		names[i] = items[i].Name
	}
	return strings.Join(names, ", ")
}

// fmtNumDisplayPrecision is the number of decimal places fmtNum rounds to.
// This is prompt-hygiene only: full float precision (e.g.
// "142.857142857143") is noisy and unnecessary in LLM-facing prose/Facts.
const fmtNumDisplayPrecision = 1

// fmtNum renders a float deterministically, rounded to
// fmtNumDisplayPrecision decimal places with trailing zeros trimmed (1450
// not 1450.0; 12.5 stays 12.5; 142.857142857143 becomes 142.9), so prose and
// Facts values match exactly.
func fmtNum(v float64) string {
	scale := math.Pow(10, fmtNumDisplayPrecision)
	rounded := math.Round(v*scale) / scale
	if rounded == 0 {
		rounded = 0 // normalize -0 (e.g. from rounding a tiny negative value) to 0
	}
	return strconv.FormatFloat(rounded, 'f', -1, 64)
}
