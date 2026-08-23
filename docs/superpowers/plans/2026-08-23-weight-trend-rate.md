# Weight-Trend Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a past-tense rate of change beneath the Trends chart — "About 0.4 kg per week, based on 9 readings over the last 42 days" — gated by the #23 Protective policy.

**Architecture:** A pure Go function fits ordinary least squares over the points for one metric and returns a per-week slope. A handler gates it on `guardrails.AtRisk` and returns structured facts. The client converts to display units and composes the sentence, so imperial users read lb/in.

**Tech Stack:** Go 1.26 + Gin + GORM; Expo SDK 57 / React Native + TanStack Query; jest; Go `testing` + testify.

**Spec:** `docs/superpowers/specs/2026-08-23-weight-trend-rate-design.md` — read it first. The plan argues from it.

## Global Constraints

- **The repo is PUBLIC.** Never put a real body measurement or weight in code, tests, fixtures, commits or PRs. Use obviously-synthetic numbers.
- **Never run prettier.** No prettier config exists; it has silently swallowed an edit before.
- **Do not poll CI.** No `gh run watch`, no looping `gh run list`.
- **Mutation-check every new test** and report it concretely: broke X, went red with <message>, restored, green.
- Commit messages: single line, conventional prefix, no signatures, no `Co-Authored-By`. Reference `(#45)`.
- Gate values, verbatim from the spec: **4+ readings spanning 14+ days**, measured on the fitted points.
- Copy rules, verbatim: past tense; names its own basis; **no future-tense verb, no date, no "on track to", no goal reference**; rate rounded to **one decimal**.
- `weight_kg` and tape measurements (`neck_cm`, `chest_cm`, `waist_cm`, `hip_cm`, `arm_cm`, `thigh_cm`) fit across all sources. Every other metric fits on the trailing same-instrument run only.
- The guardrail **fails closed**: any error obtaining signals returns `suppressed` with no rate.

---

### Task 1: Pure weekly-rate computation

**Files:**
- Create: `api/internal/tracking/trend.go`
- Test: `api/internal/tracking/trend_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type RatePoint struct { At time.Time; Value float64 }`, `type RateBasis struct { Readings int; Days int }`, `type RateResult struct { PerWeek float64; Basis RateBasis }`, and `func WeeklyRate(points []RatePoint) (RateResult, bool)` — false means the gate rejected it.

- [ ] **Step 1: Write the failing test**

```go
package tracking

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func day(n int) time.Time {
	return time.Date(2026, 6, 1, 8, 0, 0, 0, time.UTC).AddDate(0, 0, n)
}

// A clean -0.5/week line over 4 weeks. Values are synthetic.
func TestWeeklyRateFitsASteadyDecline(t *testing.T) {
	points := []RatePoint{
		{At: day(0), Value: 80},
		{At: day(7), Value: 79.5},
		{At: day(14), Value: 79},
		{At: day(21), Value: 78.5},
		{At: day(28), Value: 78},
	}
	got, ok := WeeklyRate(points)
	require.True(t, ok)
	require.InDelta(t, -0.5, got.PerWeek, 0.0001)
	require.Equal(t, 5, got.Basis.Readings)
	require.Equal(t, 28, got.Basis.Days)
}

// OLS, not first-minus-last: one bloated reading must not define the slope.
func TestWeeklyRateIsNotDominatedBySingleOutlier(t *testing.T) {
	steady := []RatePoint{
		{At: day(0), Value: 80}, {At: day(7), Value: 79.5},
		{At: day(14), Value: 79}, {At: day(21), Value: 78.5},
		{At: day(28), Value: 78},
	}
	spiked := append([]RatePoint{}, steady...)
	spiked[len(spiked)-1] = RatePoint{At: day(28), Value: 81}

	base, _ := WeeklyRate(steady)
	out, ok := WeeklyRate(spiked)
	require.True(t, ok)
	// One bloated final reading does flip the sign either way -- the claim
	// OLS earns is that it is flipped LESS far. Last-minus-first hands the
	// whole slope to that one reading (+0.25/week); OLS gives +0.1/week,
	// because the three readings in between still pull on the fit.
	lastMinusFirst := (spiked[len(spiked)-1].Value - spiked[0].Value) / 4
	require.InDelta(t, 0.25, lastMinusFirst, 0.0001)
	require.Less(t, out.PerWeek, lastMinusFirst,
		"OLS must be swung less by a single outlier than last-minus-first")
	require.Greater(t, out.PerWeek, base.PerWeek)
}

func TestWeeklyRateRejectsTooFewReadings(t *testing.T) {
	_, ok := WeeklyRate([]RatePoint{
		{At: day(0), Value: 80}, {At: day(10), Value: 79}, {At: day(20), Value: 78},
	})
	require.False(t, ok, "3 readings is below the 4-reading gate")
}

func TestWeeklyRateRejectsTooShortASpan(t *testing.T) {
	_, ok := WeeklyRate([]RatePoint{
		{At: day(0), Value: 80}, {At: day(3), Value: 79.8},
		{At: day(6), Value: 79.6}, {At: day(10), Value: 79.4},
	})
	require.False(t, ok, "10 days is below the 14-day gate")
}

func TestWeeklyRateRejectsReadingsAllAtOneInstant(t *testing.T) {
	at := day(0)
	_, ok := WeeklyRate([]RatePoint{
		{At: at, Value: 80}, {At: at, Value: 80.1},
		{At: at, Value: 79.9}, {At: at, Value: 80.2},
	})
	require.False(t, ok, "zero time variance has no slope and must not divide by zero")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/tracking/ -run TestWeeklyRate -count=1`
Expected: FAIL — `undefined: RatePoint`, `undefined: WeeklyRate`.

- [ ] **Step 3: Write minimal implementation**

```go
package tracking

import "time"

// minRateReadings and minRateSpanDays are the gate from the design doc.
// BOTH are required: a count alone lets four weigh-ins in one morning
// produce a "weekly rate", and a span alone lets two readings a month
// apart do it. They are measured on the points actually fitted, never on
// the range the caller asked for.
const (
	minRateReadings = 4
	minRateSpanDays = 14
)

// RatePoint is one reading being fitted.
type RatePoint struct {
	At    time.Time
	Value float64
}

// RateBasis is the evidence behind a rate — shown to the user, so it must
// describe the points FITTED, not the window requested.
type RateBasis struct {
	Readings int
	Days     int
}

// RateResult is a fitted rate in units-per-week.
type RateResult struct {
	PerWeek float64
	Basis   RateBasis
}

// WeeklyRate fits ordinary least squares over (time, value) and returns the
// slope per week. ok is false when the gate rejects the input.
//
// OLS rather than last-minus-first because last-minus-first is determined
// entirely by two readings: one bloated morning at either end swings it
// wildly, and can flip its sign.
func WeeklyRate(points []RatePoint) (RateResult, bool) {
	if len(points) < minRateReadings {
		return RateResult{}, false
	}
	first, last := points[0].At, points[len(points)-1].At
	spanDays := int(last.Sub(first).Hours() / 24)
	if spanDays < minRateSpanDays {
		return RateResult{}, false
	}

	// x in days since the first reading; keeps the numbers small and makes
	// the slope trivially convertible to per-week.
	var sumX, sumY float64
	for _, p := range points {
		sumX += p.At.Sub(first).Hours() / 24
		sumY += p.Value
	}
	n := float64(len(points))
	meanX, meanY := sumX/n, sumY/n

	var num, den float64
	for _, p := range points {
		dx := p.At.Sub(first).Hours()/24 - meanX
		num += dx * (p.Value - meanY)
		den += dx * dx
	}
	if den == 0 {
		// Every reading at the same instant: no slope exists. Guarded
		// explicitly rather than relying on the span gate, because equal
		// timestamps can still clear a span if the caller passes odd data.
		return RateResult{}, false
	}

	return RateResult{
		PerWeek: (num / den) * 7,
		Basis:   RateBasis{Readings: len(points), Days: spanDays},
	}, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/tracking/ -run TestWeeklyRate -count=1 -v`
Expected: PASS, all five tests.

- [ ] **Step 5: Mutation-check**

Apply each, confirm RED, restore, confirm GREEN. Report each concretely.
1. `minRateReadings` 4 → 3 — expect `TestWeeklyRateRejectsTooFewReadings` to fail.
2. `minRateSpanDays` 14 → 7 — expect `TestWeeklyRateRejectsTooShortASpan` to fail.
3. `* 7` → `* 1` — expect `TestWeeklyRateFitsASteadyDecline` to fail on `PerWeek`.
4. Replace the OLS block with `(last.Value - first.Value) / spanWeeks` — expect `TestWeeklyRateIsNotDominatedBySingleOutlier` to fail on the `Less(out.PerWeek, lastMinusFirst)` assertion (they become equal).
5. Delete the `den == 0` guard — expect `TestWeeklyRateRejectsReadingsAllAtOneInstant` to fail (NaN, not false).

- [ ] **Step 6: Commit**

```bash
git add api/internal/tracking/trend.go api/internal/tracking/trend_test.go
git commit -m "feat(tracking): fit a weekly rate of change over weigh-in readings (#45)"
```

---

### Task 2: Metric-aware point selection

**Files:**
- Modify: `api/internal/tracking/trend.go`
- Test: `api/internal/tracking/trend_test.go`

**Interfaces:**
- Consumes: `RatePoint` from Task 1.
- Produces: `func FitsAcrossInstruments(metric string) bool` and `func PointsForMetric(entries []WeightEntry, metric string) ([]RatePoint, bool)` — the bool is `spansInstruments`.

- [ ] **Step 1: Write the failing test**

```go
func entry(n int, src Source, weight float64, bodyFat *float64) WeightEntry {
	return WeightEntry{LoggedAt: day(n), WeightKg: weight, BodyFatPct: bodyFat, Source: src}
}

func pct(v float64) *float64 { return &v }

// Weight is a kilogram whichever scale reported it, so all sources fit.
func TestPointsForWeightSpanAllSources(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, nil),
		entry(7, SourceManual, 79.5, nil),
		entry(14, SourceHealthKit, 79, nil),
		entry(21, SourceScaleScreenshot, 78.5, nil),
	}
	points, spans := PointsForMetric(entries, "weight_kg")
	require.Len(t, points, 4, "weight must not be split by instrument")
	require.True(t, spans)
}

// Vendors disagree about body fat by 20+ points, so only the trailing run fits.
func TestPointsForBodyFatUseTrailingInstrumentRunOnly(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, pct(30)),
		entry(7, SourceManual, 79.5, pct(29)),
		entry(14, SourceScaleScreenshot, 79, pct(24)),
		entry(21, SourceScaleScreenshot, 78.5, pct(23.5)),
	}
	points, spans := PointsForMetric(entries, "body_fat_pct")
	require.Len(t, points, 2, "only the trailing scale_screenshot run may be fitted")
	require.False(t, spans, "a single-instrument run never spans instruments")
	require.InDelta(t, 24, points[0].Value, 0.0001)
}

// A tape is a tape; source describes the WEIGH-IN, not the measurement.
func TestPointsForTapeMeasurementSpanAllSources(t *testing.T) {
	waist := func(v float64) *float64 { return &v }
	entries := []WeightEntry{
		{LoggedAt: day(0), WeightKg: 80, WaistCm: waist(90), Source: SourceManual},
		{LoggedAt: day(7), WeightKg: 79.5, WaistCm: waist(89), Source: SourceManual},
		{LoggedAt: day(14), WeightKg: 79, WaistCm: waist(88), Source: SourceScaleScreenshot},
		{LoggedAt: day(21), WeightKg: 78.5, WaistCm: waist(87), Source: SourceScaleScreenshot},
	}
	points, _ := PointsForMetric(entries, "waist_cm")
	require.Len(t, points, 4, "a tape series must not be split on the weigh-in's instrument")
}

func TestPointsForMetricSkipsEntriesMissingThatMetric(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, pct(30)),
		entry(7, SourceManual, 79.5, nil),
		entry(14, SourceManual, 79, pct(29)),
	}
	points, _ := PointsForMetric(entries, "body_fat_pct")
	require.Len(t, points, 2, "an absent optional metric is not a zero reading")
}

func TestFitsAcrossInstruments(t *testing.T) {
	require.True(t, FitsAcrossInstruments("weight_kg"))
	require.True(t, FitsAcrossInstruments("waist_cm"))
	require.True(t, FitsAcrossInstruments("thigh_cm"))
	require.False(t, FitsAcrossInstruments("body_fat_pct"))
	require.False(t, FitsAcrossInstruments("muscle_mass_kg"))
	require.False(t, FitsAcrossInstruments("scale_bmr_kcal"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/tracking/ -run 'TestPointsFor|TestFitsAcross' -count=1`
Expected: FAIL — `undefined: PointsForMetric`, `undefined: FitsAcrossInstruments`.

- [ ] **Step 3: Write minimal implementation**

Read `model.go` for the exact `WeightEntry` field names and `Source` constants before writing this; the map below must match them.

```go
// tapeMetrics are the measurements taken with a tape rather than by the
// instrument named in Source. Kept as a set rather than a "_cm" suffix
// check so that adding a future centimetre column is a deliberate decision.
var tapeMetrics = map[string]bool{
	"neck_cm": true, "chest_cm": true, "waist_cm": true,
	"hip_cm": true, "arm_cm": true, "thigh_cm": true,
}

// FitsAcrossInstruments reports whether a metric may be fitted across a
// change of instrument.
//
// This deliberately departs from bodyCompositionSeries.ts, which refuses
// EVERY cross-instrument figure. Two reasons, both in the design doc:
// vendors disagree about body fat by 20+ points but about weight by a few
// hundred grams, well inside the noise a weekly rate already tolerates; and
// Source describes the WEIGH-IN, so splitting a tape series on it would
// split on something unrelated to how the tape was read.
func FitsAcrossInstruments(metric string) bool {
	return metric == "weight_kg" || tapeMetrics[metric]
}

// PointsForMetric selects the readings to fit, oldest first. The second
// return is whether those points span more than one instrument, which the
// caller surfaces as a note beside the figure.
func PointsForMetric(entries []WeightEntry, metric string) ([]RatePoint, bool) {
	all := make([]RatePoint, 0, len(entries))
	sources := make([]Source, 0, len(entries))
	for _, e := range entries {
		v, ok := metricValue(e, metric)
		if !ok {
			continue // absent is not zero
		}
		all = append(all, RatePoint{At: e.LoggedAt, Value: v})
		sources = append(sources, e.Source)
	}
	if len(all) == 0 {
		return nil, false
	}

	if FitsAcrossInstruments(metric) {
		return all, spansMoreThanOne(sources)
	}

	// Trailing same-instrument run only.
	start := len(all) - 1
	for start > 0 && sources[start-1] == sources[start] {
		start--
	}
	return all[start:], false
}

func spansMoreThanOne(sources []Source) bool {
	for i := 1; i < len(sources); i++ {
		if sources[i] != sources[0] {
			return true
		}
	}
	return false
}
```

Also in the same file:

```go
// metricValue reads one metric off an entry. The bool is false when the
// entry did not record it — absent is NOT zero, which is the rule the whole
// composition schema is built on.
//
// Exhaustive on purpose, with no value-returning default: a default of
// `0, true` would turn an unknown metric name into a fabricated reading of
// zero and fit a rate through it.
func metricValue(e WeightEntry, metric string) (float64, bool) {
	if metric == "weight_kg" {
		return e.WeightKg, true
	}
	var p *float64
	switch metric {
	case "body_fat_pct":
		p = e.BodyFatPct
	case "subcutaneous_fat_pct":
		p = e.SubcutaneousFatPct
	case "visceral_fat_rating":
		p = e.VisceralFatRating
	case "skeletal_muscle_pct":
		p = e.SkeletalMusclePct
	case "muscle_mass_kg":
		p = e.MuscleMassKg
	case "body_water_pct":
		p = e.BodyWaterPct
	case "protein_pct":
		p = e.ProteinPct
	case "bone_mass_kg":
		p = e.BoneMassKg
	case "scale_bmr_kcal":
		p = e.ScaleBMRKcal
	case "neck_cm":
		p = e.NeckCm
	case "chest_cm":
		p = e.ChestCm
	case "waist_cm":
		p = e.WaistCm
	case "hip_cm":
		p = e.HipCm
	case "arm_cm":
		p = e.ArmCm
	case "thigh_cm":
		p = e.ThighCm
	default:
		return 0, false
	}
	if p == nil {
		return 0, false
	}
	return *p, true
}
```

Verify these field names against `api/internal/tracking/model.go` before running — they are copied from it, but it is the source of truth. `knownMetric` in Task 4 is the same list of fifteen keys; keep the two in step.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/tracking/ -count=1`
Expected: PASS, including Task 1's tests.

- [ ] **Step 5: Mutation-check**

1. `FitsAcrossInstruments` → `return false` — expect the weight and tape span tests to fail.
2. `FitsAcrossInstruments` → `return true` — expect `TestPointsForBodyFatUseTrailingInstrumentRunOnly` to fail with 4 points.
3. In the `!ok` branch, append `RatePoint{At: e.LoggedAt, Value: 0}` instead of skipping — expect `TestPointsForMetricSkipsEntriesMissingThatMetric` to fail.
4. Change the trailing-run loop to scan forward from 0 — expect the body-fat test to fail on `points[0].Value`.

- [ ] **Step 6: Commit**

```bash
git add api/internal/tracking/trend.go api/internal/tracking/trend_test.go
git commit -m "feat(tracking): pick rate points per metric, honouring instrument changes (#45)"
```

---

### Task 3: SignalsSource seam

**Files:**
- Modify: `api/internal/tracking/trend.go` (interface only)
- Create: `api/internal/coach/signals_source.go`
- Test: `api/internal/coach/signals_source_test.go`

**Interfaces:**
- Produces: `tracking.SignalsSource` with `SignalsFor(ctx context.Context, userID uuid.UUID) (guardrails.Signals, error)`, and `coach.NewSignalsSource(g Grounder, loc *time.Location) SignalsSource`.

`tracking` must NOT import `coach`. The interface is declared in `tracking`; `coach` satisfies it structurally.

- [ ] **Step 1: Write the failing test**

```go
package coach

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The adapter must return exactly what SignalsFrom computes for the built
// context — no second definition of risk may appear here.
func TestSignalsSourceReturnsSignalsFromBuiltContext(t *testing.T) {
	g := newTestGrounder(t) // build with the package's existing test helpers
	src := NewSignalsSource(g, time.UTC)

	got, err := src.SignalsFor(context.Background(), uuid.New())
	require.NoError(t, err)

	ctx, err := g.BuildContext(context.Background(), uuid.New(), time.Now(), time.UTC)
	require.NoError(t, err)
	require.Equal(t, SignalsFrom(ctx), got)
}

func TestSignalsSourcePropagatesBuildFailure(t *testing.T) {
	src := NewSignalsSource(failingGrounder(t), time.UTC)
	_, err := src.SignalsFor(context.Background(), uuid.New())
	require.Error(t, err, "an unknown risk state must reach the caller, never read as no-risk")
}
```

Before writing this, read `api/internal/coach/grounding_test.go` and reuse whatever fake `dashboard.Service` / `LogSource` / `memory.Service` / `WeightSource` it already builds; name the helpers to match what is there rather than inventing `newTestGrounder` if an equivalent exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/coach/ -run TestSignalsSource -count=1`
Expected: FAIL — `undefined: NewSignalsSource`.

- [ ] **Step 3: Write minimal implementation**

```go
package coach

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/guardrails"
)

// signalsSource adapts Grounder to the narrow interface tracking declares.
//
// It exists so that tracking never imports coach and never recomputes risk:
// SignalsFrom stays the single definition, which is what #23 was filed to
// protect. See the design doc, decision 5.
type signalsSource struct {
	grounder Grounder
	loc      *time.Location
}

func NewSignalsSource(g Grounder, loc *time.Location) signalsSource {
	return signalsSource{grounder: g, loc: loc}
}

func (s signalsSource) SignalsFor(ctx context.Context, userID uuid.UUID) (guardrails.Signals, error) {
	built, err := s.grounder.BuildContext(ctx, userID, time.Now(), s.loc)
	if err != nil {
		return guardrails.Signals{}, fmt.Errorf("coach: signals for trend: %w", err)
	}
	return SignalsFrom(built), nil
}
```

And in `api/internal/tracking/trend.go`:

```go
// SignalsSource supplies the risk signals the Protective policy needs.
// Declared here and satisfied by coach so that tracking never imports it —
// the risk computation must have exactly one definition (design doc,
// decision 5).
type SignalsSource interface {
	SignalsFor(ctx context.Context, userID uuid.UUID) (guardrails.Signals, error)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/coach/ ./internal/tracking/ -count=1`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. Return `guardrails.Signals{}, nil` on build error — expect `TestSignalsSourcePropagatesBuildFailure` to fail.
2. Return a hand-built `guardrails.Signals{}` instead of `SignalsFrom(built)` — expect the first test to fail.

- [ ] **Step 6: Commit**

```bash
git add api/internal/coach/signals_source.go api/internal/coach/signals_source_test.go api/internal/tracking/trend.go
git commit -m "feat(coach): expose risk signals through a narrow source interface (#45)"
```

---

### Task 4: The endpoint

**Files:**
- Modify: `api/internal/tracking/handler.go`
- Modify: `api/internal/server/router.go:328` (register beside the existing weight routes)
- Test: `api/internal/tracking/handler_test.go`

**Interfaces:**
- Consumes: `WeeklyRate`, `PointsForMetric`, `SignalsSource`.
- Produces: `GET /v1/weight/trend?metric=&range=` returning `{"data": {...}}` per the spec.

- [ ] **Step 1: Write the failing test**

```go
type fakeSignals struct {
	signals guardrails.Signals
	err     error
}

func (f fakeSignals) SignalsFor(context.Context, uuid.UUID) (guardrails.Signals, error) {
	return f.signals, f.err
}

func trendRouter(userID uuid.UUID, repo Repository, sig SignalsSource) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	h := NewHandler(repo).WithSignals(sig)
	r.GET("/v1/weight/trend", h.WeightTrend)
	return r
}

func seedDecline(t *testing.T, repo Repository, userID uuid.UUID) {
	t.Helper()
	for i, w := range []float64{80, 79.5, 79, 78.5, 78} {
		at := time.Now().AddDate(0, 0, -28+(i*7))
		_, err := repo.AddWeight(context.Background(), userID, w, at, dayOf(at))
		require.NoError(t, err)
	}
}

func TestWeightTrendReturnsARateWhenNotAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	r := trendRouter(userID, repo, fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
			Basis       struct {
				Readings int `json:"readings"`
				Days     int `json:"days"`
			} `json:"basis"`
			ShowSupport bool `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "ok", body.Data.Status)
	require.NotNil(t, body.Data.RatePerWeek)
	require.InDelta(t, -0.5, *body.Data.RatePerWeek, 0.05)
	require.Equal(t, 5, body.Data.Basis.Readings)
	require.False(t, body.Data.ShowSupport)
}

// The guardrail. This is the test that must go red if suppression is removed.
func TestWeightTrendSuppressesForAnAtRiskUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	atRisk := guardrails.Signals{RecentDeficitPct: 0.95, AvgIntakeKcal: 600, LogsPerDay: 1}
	require.True(t, guardrails.AtRisk(atRisk), "fixture must actually trip the policy")

	r := trendRouter(userID, repo, fakeSignals{signals: atRisk})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
			ShowSupport bool     `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "suppressed", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek, "a suppressed rate must not be on the wire at all")
	require.True(t, body.Data.ShowSupport)
}

// Fails closed: unknown risk is not no-risk.
func TestWeightTrendSuppressesWhenSignalsAreUnavailable(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	r := trendRouter(userID, repo, fakeSignals{err: errors.New("grounding failed")})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code, "a signals failure is not the caller's error")

	var body struct{ Data struct {
		Status      string   `json:"status"`
		RatePerWeek *float64 `json:"rate_per_week"`
	} `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "suppressed", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek)
}

func TestWeightTrendReportsInsufficientData(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	at := time.Now().AddDate(0, 0, -3)
	_, err := repo.AddWeight(context.Background(), userID, 80, at, dayOf(at))
	require.NoError(t, err)

	r := trendRouter(userID, repo, fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))

	var body struct{ Data struct{ Status string `json:"status"` } `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "insufficient_data", body.Data.Status)
}

func TestWeightTrendRejectsAnUnknownMetric(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := trendRouter(userID, NewRepository(db), fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=nonsense&range=3M", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/tracking/ -run TestWeightTrend -count=1`
Expected: FAIL — `h.WithSignals undefined`, `h.WeightTrend undefined`.

- [ ] **Step 3: Write minimal implementation**

Range keys must match the client's `WEIGHT_RANGE_DAYS`: `1W`=7, `1M`=30, `3M`=90, `1Y`=365; anything else defaults to 30.

```go
// WithSignals returns a copy of the handler that can gate a trend on the
// Protective policy. Kept optional so every existing NewHandler caller
// (onboarding, tests) compiles unchanged.
func (h Handler) WithSignals(s SignalsSource) Handler {
	h.signals = s
	return h
}

type trendBasis struct {
	Readings int `json:"readings"`
	Days     int `json:"days"`
}

type trendResponse struct {
	Status           string      `json:"status"`
	RatePerWeek      *float64    `json:"rate_per_week,omitempty"`
	Basis            *trendBasis `json:"basis,omitempty"`
	SpansInstruments bool        `json:"spans_instruments"`
	ShowSupport      bool        `json:"show_support"`
}

func (h Handler) WeightTrend(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	metric := c.Query("metric")
	if !knownMetric(metric) {
		httpx.Error(c, http.StatusBadRequest, "invalid_metric", "unknown metric")
		return
	}

	// Signals FIRST and fail closed: an unknown risk state must never be
	// read as "no risk". Returning 200 with suppressed (rather than 5xx) is
	// deliberate — a grounding failure is not the caller's error, and a
	// retry loop on the Trends screen would be worse than a missing figure.
	if h.signals == nil {
		c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "suppressed"}})
		return
	}
	signals, err := h.signals.SignalsFor(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "suppressed"}})
		return
	}
	if guardrails.AtRisk(signals) {
		c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "suppressed", ShowSupport: true}})
		return
	}

	to := endOfUTCDay(time.Now())
	from := to.AddDate(0, 0, -rangeDays(c.Query("range")))
	entries, err := h.repo.WeightSeries(c.Request.Context(), userID, from, to)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load weight series")
		return
	}

	points, spans := PointsForMetric(entries, metric)
	result, fitted := WeeklyRate(points)
	if !fitted {
		c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "insufficient_data", SpansInstruments: spans}})
		return
	}
	basis := trendBasis{Readings: result.Basis.Readings, Days: result.Basis.Days}
	c.JSON(http.StatusOK, gin.H{"data": trendResponse{
		Status: "ok", RatePerWeek: &result.PerWeek, Basis: &basis, SpansInstruments: spans,
	}})
}
```

Add the `signals SignalsSource` field to `Handler`, plus `knownMetric` and `rangeDays` helpers. `knownMetric` must be an explicit allow-list of the fifteen keys — never a permissive default.

Register in `router.go` immediately after line 328:

```go
v1.GET("/weight/trend", trackingHandler.WithSignals(
    coach.NewSignalsSource(grounder, loc),
).WeightTrend)
```

Read the surrounding lines for the existing `grounder` and location variables and reuse them; if the coach grounder is constructed later in the file, move this registration below it rather than building a second grounder.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go build ./... && go test ./internal/tracking/ -count=1`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. **Delete the `AtRisk` branch** — expect `TestWeightTrendSuppressesForAnAtRiskUser` to fail. This is the guardrail proof; report it explicitly.
2. On signals error, continue instead of suppressing — expect `TestWeightTrendSuppressesWhenSignalsAreUnavailable` to fail.
3. In the suppressed response, set `RatePerWeek: &result.PerWeek` — expect the `require.Nil` assertion to fail.
4. `knownMetric` → `return true` — expect `TestWeightTrendRejectsAnUnknownMetric` to fail.

- [ ] **Step 6: Commit**

```bash
git add api/internal/tracking/handler.go api/internal/tracking/handler_test.go api/internal/server/router.go
git commit -m "feat(tracking): serve a guardrailed weekly rate for a metric (#45)"
```

---

### Task 5: Client hook and types

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces: `WeightTrend` type and `useWeightTrend(metric: CompositionMetricKey, range: WeightRange)`.

- [ ] **Step 1: Write the failing test**

```tsx
test("useWeightTrend GETs /v1/weight/trend for the selected metric and range", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({
    status: "ok",
    rate_per_week: -0.4,
    basis: { readings: 9, days: 42 },
    spans_instruments: false,
    show_support: false,
  });
  const { result } = await renderHook(() => useWeightTrend("waist_cm", "3M"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const calls = (apiFetch as jest.Mock).mock.calls;
  expect(calls[calls.length - 1][0]).toBe("/v1/weight/trend?metric=waist_cm&range=3M");
  expect(result.current.data?.status).toBe("ok");
});

test("useWeightTrend caches per metric, so switching chips does not reuse a stale rate", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ status: "insufficient_data" });
  const { result: a } = await renderHook(() => useWeightTrend("weight_kg", "1M"), { wrapper });
  await waitFor(() => expect(a.current.isSuccess).toBe(true));
  const { result: b } = await renderHook(() => useWeightTrend("body_fat_pct", "1M"), { wrapper });
  await waitFor(() => expect(b.current.isSuccess).toBe(true));

  const urls = (apiFetch as jest.Mock).mock.calls.map((c) => c[0] as string);
  expect(urls).toContain("/v1/weight/trend?metric=weight_kg&range=1M");
  expect(urls).toContain("/v1/weight/trend?metric=body_fat_pct&range=1M");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/api/__tests__/hooks.test.tsx -t useWeightTrend`
Expected: FAIL — `useWeightTrend is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `types.ts`:

```ts
/** The decided result of POST-free trend read. `rate_per_week` is absent
 *  unless status is "ok" — a suppressed rate is never on the wire. */
export interface WeightTrend {
  status: "ok" | "insufficient_data" | "suppressed";
  rate_per_week?: number;
  basis?: { readings: number; days: number };
  spans_instruments: boolean;
  show_support: boolean;
}
```

In `hooks.ts`, beside `useWeightSeries`:

```ts
export function useWeightTrend(metric: CompositionMetricKey, range: WeightRange) {
  return useQuery({
    // Keyed by BOTH, so switching a chip cannot show the previous metric's
    // rate under the new metric's name.
    queryKey: ["weight-trend", metric, range],
    queryFn: () =>
      apiFetch(`/v1/weight/trend?metric=${metric}&range=${range}`) as Promise<WeightTrend>,
  });
}
```

Do NOT add `placeholderData: keepPreviousData` here. `useWeightSeries` uses it so the chart does not flash an empty state, but a rate carried across a metric switch would be a wrong number under a right label.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/api/__tests__/hooks.test.tsx -t useWeightTrend`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. Drop `metric` from `queryKey` — expect the caching test to fail.
2. Add `placeholderData: keepPreviousData` — confirm whether either test catches it; if neither does, add an assertion that a metric switch yields `undefined` data before its own fetch resolves, then mutation-check that.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): read the weekly rate for the selected metric (#45)"
```

---

### Task 6: The estimate-framed sentence

**Files:**
- Create: `apps/mobile/src/lib/trendCopy.ts`
- Test: `apps/mobile/src/lib/__tests__/trendCopy.test.ts`

**Interfaces:**
- Consumes: `WeightTrend`, `CompositionMetric`, `UnitSystem`, and `displayNumber`/`unitLabel` from `bodyCompositionFields.ts`.
- Produces: `function trendSentence(trend: WeightTrend, metric: CompositionMetric, system: UnitSystem): string | null` — null means render nothing.

- [ ] **Step 1: Write the failing test**

```ts
import { trendSentence } from "../trendCopy";
import { COMPOSITION_METRICS } from "../bodyCompositionFields";

const weight = COMPOSITION_METRICS.find((m) => m.key === "weight_kg")!;
const waist = COMPOSITION_METRICS.find((m) => m.key === "waist_cm")!;
const ok = { status: "ok" as const, rate_per_week: -0.4, basis: { readings: 9, days: 42 }, spans_instruments: false, show_support: false };

test("states the rate in the past tense, with its basis", () => {
  expect(trendSentence(ok, weight, "metric")).toBe(
    "About 0.4 kg per week down — based on 9 readings over the last 42 days.",
  );
});

test("says up for a gain, never a bare signed number", () => {
  expect(trendSentence({ ...ok, rate_per_week: 0.25 }, weight, "metric")).toContain("0.3 kg per week up");
});

test("converts to the reader's units", () => {
  const s = trendSentence(ok, weight, "imperial");
  expect(s).toContain("lb per week");
  expect(s).not.toContain("kg");
});

test("uses inches for a tape measurement in imperial", () => {
  const s = trendSentence({ ...ok, rate_per_week: -1 }, waist, "imperial");
  expect(s).toContain("in per week");
});

test("renders nothing when there is not enough data", () => {
  expect(trendSentence({ ...ok, status: "insufficient_data", rate_per_week: undefined, basis: undefined }, weight, "metric")).toBeNull();
});

test("renders nothing when suppressed", () => {
  expect(trendSentence({ ...ok, status: "suppressed", rate_per_week: undefined, basis: undefined }, weight, "metric")).toBeNull();
});

// The #23 requirement, asserted as exclusions rather than trusted as a convention.
test("never promises: no future tense, no date, no goal", () => {
  for (const rate of [-0.9, -0.1, 0, 0.1, 0.9]) {
    const s = trendSentence({ ...ok, rate_per_week: rate }, weight, "metric") ?? "";
    expect(s).not.toMatch(/\bwill\b|\byou'?ll\b|\bexpect\b|\bby [A-Z][a-z]+\b|\bon track\b|\bgoal\b|\breach\b/i);
  }
});

test("rounds to one decimal — more digits are false precision here", () => {
  expect(trendSentence({ ...ok, rate_per_week: -0.4567 }, weight, "metric")).toContain("0.5 kg per week");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/lib/__tests__/trendCopy.test.ts`
Expected: FAIL — cannot resolve `../trendCopy`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { WeightTrend } from "@/api/types";
import type { UnitSystem } from "@/units";
import { displayNumber, unitLabel, type CompositionMetric } from "./bodyCompositionFields";

/**
 * The one place a rate becomes a sentence (kora#45, framed per kora#23).
 *
 * Past tense, and it names its own basis. It states what HAS happened over a
 * measured window and makes no claim about what will happen — no future
 * tense, no date, no goal, no "on track". Those are what turn an estimate
 * into a promise, and there is a test asserting each of them is absent.
 *
 * Returns null for anything but a fitted rate. A suppressed trend carries no
 * number at all, so there is nothing here to leak.
 */
export function trendSentence(
  trend: WeightTrend,
  metric: CompositionMetric,
  system: UnitSystem,
): string | null {
  if (trend.status !== "ok" || trend.rate_per_week === undefined || !trend.basis) return null;

  const converted = displayNumber(metric, trend.rate_per_week, system);
  const magnitude = Math.abs(converted).toFixed(1);
  const unit = unitLabel(metric, system);
  const direction = converted > 0 ? " up" : converted < 0 ? " down" : "";
  const { readings, days } = trend.basis;

  return `About ${magnitude}${unit ? ` ${unit}` : ""} per week${direction} — based on ${readings} readings over the last ${days} days.`;
}
```

`displayNumber` converts a stored value to display units; a rate is a difference, and both kg→lb and cm→in are linear with no offset, so converting the rate directly is correct. Confirm that by reading `displayNumber` before relying on it — if it ever gains an offset, this must convert two endpoints and subtract instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/lib/__tests__/trendCopy.test.ts`
Expected: PASS, all eight tests.

- [ ] **Step 5: Mutation-check**

1. Drop the `status !== "ok"` guard — expect both null tests to fail.
2. `toFixed(1)` → `toFixed(3)` — expect the rounding test to fail.
3. Return `converted` unconverted (skip `displayNumber`) — expect both imperial tests to fail.
4. Append `" — on track to reach your goal."` — expect the promise-exclusion test to fail. **Report this one explicitly: it is the #23 requirement proving itself.**
5. Swap the `up`/`down` ternary arms — expect the gain test to fail.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/trendCopy.ts apps/mobile/src/lib/__tests__/trendCopy.test.ts
git commit -m "feat(mobile): compose the estimate-framed rate sentence (#45)"
```

---

### Task 7: Render it on Trends

**Files:**
- Modify: `apps/mobile/app/(tabs)/progress.tsx` (beside the existing change-over-range figure, near line 330)
- Test: `apps/mobile/app/(tabs)/__tests__/progress-composition.test.tsx`

**Interfaces:**
- Consumes: `useWeightTrend`, `trendSentence`.

- [ ] **Step 1: Write the failing test**

```tsx
test("shows the estimate-framed rate under the chart", async () => {
  mockUseWeightTrend.mockReturnValue({
    data: { status: "ok", rate_per_week: -0.4, basis: { readings: 9, days: 42 }, spans_instruments: false, show_support: false },
    isSuccess: true,
  });
  const { findByText } = await render(<Progress />);
  expect(await findByText(/About 0.4 kg per week down/)).toBeTruthy();
});

test("shows nothing at all when the rate is suppressed", async () => {
  mockUseWeightTrend.mockReturnValue({
    data: { status: "suppressed", spans_instruments: false, show_support: true },
    isSuccess: true,
  });
  const { queryByText } = await render(<Progress />);
  expect(queryByText(/per week/)).toBeNull();
});

test("notes an instrument change beside the rate rather than hiding it", async () => {
  mockUseWeightTrend.mockReturnValue({
    data: { status: "ok", rate_per_week: -0.4, basis: { readings: 9, days: 42 }, spans_instruments: true, show_support: false },
    isSuccess: true,
  });
  const { findByText } = await render(<Progress />);
  expect(await findByText(/more than one instrument/i)).toBeTruthy();
});
```

Mock `useWeightTrend` alongside however this file already mocks `useWeightSeries`; match the existing pattern rather than introducing a second mocking style.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest "app/(tabs)/__tests__/progress-composition.test.tsx"`
Expected: FAIL — the rate text is not rendered.

- [ ] **Step 3: Write minimal implementation**

Render beneath `<WeightChart .../>`:

```tsx
{(() => {
  const sentence = trend.data ? trendSentence(trend.data, selectedMetric, system) : null;
  if (!sentence) return null;
  return (
    <View>
      <AppText style={mutedLabel}>{sentence}</AppText>
      {trend.data?.spans_instruments ? (
        <AppText style={mutedLabel}>These readings come from more than one instrument.</AppText>
      ) : null}
    </View>
  );
})()}
```

Use the file's existing style variables and the metric the picker currently has selected. Do not add a support affordance for `show_support` in this task — that surface is out of scope for this plan (see the spec's "Not addressed here") and rendering nothing is the correct interim behaviour.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest "app/(tabs)/__tests__/progress-composition.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Full verification**

```bash
cd apps/mobile && npx jest && npx tsc --noEmit && npx eslint app/\(tabs\)/progress.tsx src/lib/trendCopy.ts src/api/hooks.ts
cd ../../api && go build ./... && go vet ./internal/tracking/ ./internal/coach/ && go test ./internal/tracking/ ./internal/coach/ -count=1
```

Expected: all green. Report actual output, not a summary.

- [ ] **Step 6: Mutation-check**

1. Render the sentence regardless of `status` — expect the suppressed test to fail.
2. Drop the `spans_instruments` note — expect the instrument test to fail.

- [ ] **Step 7: Commit**

```bash
git add "apps/mobile/app/(tabs)/progress.tsx" "apps/mobile/app/(tabs)/__tests__/progress-composition.test.tsx"
git commit -m "feat(mobile): show the weekly rate beneath the trend chart (#45)"
```

---

## Verification this plan cannot provide

**jest performs no layout in this repo.** Task 7's tests prove the sentence is in the tree; they prove nothing about whether it is visible on screen. A Save button once measured 743pt below the fold and shipped a silent failure (#374). The Trends card is gaining two lines of text beneath the chart.

A simulator or device check is required before this is called done, and it could not be performed from this environment: synthetic input needs accessibility privileges that are not granted on this machine. State that plainly rather than implying visual verification.
