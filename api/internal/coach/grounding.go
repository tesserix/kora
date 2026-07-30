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
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
)

// recentWindowDays is the trailing window (inclusive of today) used to
// compute averages, logging cadence, and the fasting streak.
const recentWindowDays = 7

// Fact is one grounding data point suitable for citing in a coach response.
type Fact struct{ Label, Value string }

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
}

// LogSource is the read used to aggregate RecentDaily. foodlog.Repository
// satisfies it; tests can supply a fake.
type LogSource interface {
	ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error)
}

// Grounder wires the read-only sources BuildContext aggregates.
type Grounder struct {
	Dash dashboard.Service
	Logs LogSource
	Mem  memory.Service
}

// NewGrounder constructs a Grounder from its concrete dependencies.
func NewGrounder(dash dashboard.Service, logs LogSource, mem memory.Service) Grounder {
	return Grounder{Dash: dash, Logs: logs, Mem: mem}
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

	since := now.AddDate(0, 0, -(recentWindowDays - 1))
	logs, err := g.Logs.ListForUserSince(ctx, userID, since)
	if err != nil {
		return Context{}, fmt.Errorf("coach: build context: recent logs: %w", err)
	}
	recentDaily := aggregateDaily(logs, now, loc)

	usual, err := g.Mem.Build(ctx, userID, now, loc)
	if err != nil {
		return Context{}, fmt.Errorf("coach: build context: usual foods: %w", err)
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
	}, nil
}

// aggregateDaily buckets logs into local calendar days spanning
// [now-(recentWindowDays-1), now], oldest first. Days with no logs are
// present in the result, zero-valued.
func aggregateDaily(logs []foodlog.FoodLog, now time.Time, loc *time.Location) []DailyTotal {
	nowLocal := now.In(loc)
	startDay := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc).
		AddDate(0, 0, -(recentWindowDays - 1))

	out := make([]DailyTotal, recentWindowDays)
	index := make(map[string]int, recentWindowDays)
	for i := 0; i < recentWindowDays; i++ {
		d := startDay.AddDate(0, 0, i)
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

// fastingStreak counts consecutive zero-kcal days ending at the most recent
// (last) entry of daily, i.e. today backward.
func fastingStreak(daily []DailyTotal) int {
	streak := 0
	for i := len(daily) - 1; i >= 0; i-- {
		if daily[i].Kcal > 0 {
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

// fmtNum renders a float deterministically without trailing zeros (1450 not
// 1450.000000; 12.5 stays 12.5), so prose and Facts values match exactly.
func fmtNum(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
