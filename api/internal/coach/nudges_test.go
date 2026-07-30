package coach

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/guardrails"
)

func TestBuildNudges_ProteinGapAdditive(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 65},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges)
	require.Equal(t, "Protein", r.Nudges[0].Title)
	require.Contains(t, r.Nudges[0].Text, "55")
	require.NotEmpty(t, r.Nudges[0].Reason)
	require.False(t, r.ShowSupport)
}

func TestBuildNudges_ProteinCarriesKindAndTitle(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 65},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges)
	require.Equal(t, NudgeKindProtein, r.Nudges[0].Kind)
	require.Equal(t, "Protein", r.Nudges[0].Title)
	require.Contains(t, r.Nudges[0].Text, "55")
	require.Contains(t, r.Nudges[0].Text, "120")
}

func TestBuildNudges_FibreCarriesKindAndTitle(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		RecentDaily: []DailyTotal{
			{FiberG: 10}, {FiberG: 11}, {FiberG: 9},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	var fibre *Nudge
	for i := range r.Nudges {
		if r.Nudges[i].Kind == NudgeKindFibre {
			fibre = &r.Nudges[i]
		}
	}
	require.NotNil(t, fibre, "expected a fibre nudge")
	require.Equal(t, "Fibre is low", fibre.Title)
}

func TestBuildNudges_NoProteinGapWhenTargetMet(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
		// A valid weight trend guarantees at least one surviving nudge, so
		// this loop actually iterates and the NotEqual assertion below is
		// not vacuously true over an empty slice.
		WeightTrend: WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true},
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges, "test setup must produce at least one nudge for this assertion to mean anything")
	for _, n := range r.Nudges {
		require.NotEqual(t, NudgeKindProtein, n.Kind)
	}
}

func TestBuildNudges_FiberLowStreakAdditive(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		AvgIntakeKcal: 1800,
		RecentDaily: []DailyTotal{
			{FiberG: 10}, {FiberG: 12}, {FiberG: 10}, {FiberG: 8},
			{FiberG: 5}, {FiberG: 5}, {FiberG: 5}, // last minFiberBelowTargetStreakDays+ days below target
		},
	}

	r := BuildNudges(c, SignalsFrom(c))

	found := false
	for _, n := range r.Nudges {
		if n.Kind == NudgeKindFibre {
			found = true
		}
	}
	require.True(t, found, "expected a fibre-low nudge, got %+v", r.Nudges)
}

func TestBuildNudges_NoFiberStreakBelowThreshold(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		AvgIntakeKcal: 1800,
		RecentDaily: []DailyTotal{
			// Kcal matches the 2000 target on every day so recentDeficitPct
			// stays 0 and AtRisk doesn't gate off the weight candidate below.
			{Kcal: 2000, FiberG: 40}, {Kcal: 2000, FiberG: 40}, {Kcal: 2000, FiberG: 40}, {Kcal: 2000, FiberG: 40},
			{Kcal: 2000, FiberG: 40}, {Kcal: 2000, FiberG: 40}, {Kcal: 2000, FiberG: 5}, // only today is below target
		},
		// A valid weight trend guarantees at least one surviving nudge, so
		// this loop actually iterates and the NotEqual assertion below is
		// not vacuously true over an empty slice.
		WeightTrend: WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true},
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges, "test setup must produce at least one nudge for this assertion to mean anything")
	for _, n := range r.Nudges {
		require.NotEqual(t, NudgeKindFibre, n.Kind)
	}
}

func TestBuildNudges_NoFiberNudgeWhenNoFiberTargetSet(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120}, // FiberG target unset (0)
		},
		AvgIntakeKcal: 1800,
		RecentDaily: []DailyTotal{
			// Kcal matches the 2000 target on every day so recentDeficitPct
			// stays 0 and AtRisk doesn't gate off the weight candidate below.
			{Kcal: 2000, FiberG: 0}, {Kcal: 2000, FiberG: 0}, {Kcal: 2000, FiberG: 0}, {Kcal: 2000, FiberG: 0},
			{Kcal: 2000, FiberG: 0}, {Kcal: 2000, FiberG: 0}, {Kcal: 2000, FiberG: 0},
		},
		// A valid weight trend guarantees at least one surviving nudge, so
		// this loop actually iterates and the NotEqual assertion below is
		// not vacuously true over an empty slice.
		WeightTrend: WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true},
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges, "test setup must produce at least one nudge for this assertion to mean anything")
	for _, n := range r.Nudges {
		require.NotEqual(t, NudgeKindFibre, n.Kind)
	}
}

// TestBuildNudges_NoSurvivingRestrictiveUnderRisk is the Protective
// invariant test: under an ED-risk signal, no nudge that survives
// guardrails.Evaluate may steer the user toward eating less, and
// ShowSupport must be surfaced.
func TestBuildNudges_NoSurvivingRestrictiveUnderRisk(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 20},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		AvgIntakeKcal: 1000, // <= risk threshold (1200) -> AtRisk
		RecentDaily: []DailyTotal{
			{FiberG: 5}, {FiberG: 5}, {FiberG: 5}, {FiberG: 5},
			{FiberG: 5}, {FiberG: 5}, {FiberG: 5},
		},
	}

	s := SignalsFrom(c)
	require.True(t, guardrails.AtRisk(s), "test setup must actually trigger risk")

	r := BuildNudges(c, s)

	require.True(t, r.ShowSupport)
	for _, n := range r.Nudges {
		lower := strings.ToLower(n.Text)
		require.NotContains(t, lower, "enough")
		require.NotContains(t, lower, "stop")
		require.NotContains(t, lower, "less")
	}
}

func TestBuildNudges_ShowSupportFalseWhenNoRisk(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 65},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.False(t, r.ShowSupport)
}

func weightTrendContext(trend WeightTrend, avgKcal float64, fastingStreak int) Context {
	return Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal:     avgKcal,
		FastingStreakDays: fastingStreak,
		WeightTrend:       trend,
	}
}

func hasKind(nudges []Nudge, k NudgeKind) bool {
	for _, n := range nudges {
		if n.Kind == k {
			return true
		}
	}
	return false
}

func TestBuildNudges_WeightTrendShownWhenNotAtRisk(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, hasKind(r.Nudges, NudgeKindWeightDown))
	for _, n := range r.Nudges {
		if n.Kind == NudgeKindWeightDown {
			require.Equal(t, "Weight trend", n.Title)
			require.Contains(t, n.Text, "1.8")
			require.Contains(t, strings.ToLower(n.Text), "down")
		}
	}
	require.False(t, r.ShowSupport)
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_FastingStreak(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 3)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown),
		"weight-loss framing must never be shown to an at-risk user")
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp),
		"weight-gain framing must never be shown to an at-risk user")
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_LowIntake(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1100, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown))
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp))
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_ObsessiveLogging(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 0)
	c.LogsPerDay = 12

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown))
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp))
}

// TestBuildNudges_WeightTrendHiddenWhenAtRisk_Deficit covers the 7-day
// deficit threshold, the only one of the four AtRisk pathways the sibling
// gating tests above (FastingStreak, LowIntake, ObsessiveLogging) don't
// exercise. weightTrendContext never sets RecentDaily, so recentDeficitPct
// is always 0 there — this test builds Context directly so RecentDaily can
// drive the deficit signal while AvgIntakeKcal/FastingStreakDays/LogsPerDay
// stay safely below their own thresholds.
func TestBuildNudges_WeightTrendHiddenWhenAtRisk_Deficit(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal:     1800, // above riskAvgIntakeKcal (1200): must not itself trip risk
		FastingStreakDays: 0,    // below riskFastingStreakDays (3)
		LogsPerDay:        0,    // below riskLogsPerDay (12)
		RecentDaily: []DailyTotal{
			// Each day at 1000/2000 target kcal -> per-day deficit 0.5,
			// mean recentDeficitPct 0.5, well past the 0.30 threshold.
			{Kcal: 1000}, {Kcal: 1000}, {Kcal: 1000}, {Kcal: 1000},
			{Kcal: 1000}, {Kcal: 1000}, {Kcal: 1000},
		},
		WeightTrend: WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true},
	}

	s := SignalsFrom(c)
	require.GreaterOrEqual(t, s.RecentDeficitPct, 0.30, "test setup must actually trip the deficit threshold")
	require.True(t, guardrails.AtRisk(s), "test setup must actually trigger risk")

	r := BuildNudges(c, s)

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown),
		"weight-loss framing must never be shown to an at-risk user (deficit threshold)")
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp),
		"weight-gain framing must never be shown to an at-risk user (deficit threshold)")
}

func TestBuildNudges_NoWeightTrendWhenInvalid(t *testing.T) {
	c := weightTrendContext(WeightTrend{}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown))
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp))
}

// TestBuildNudges_NoWeightTrendWhenMagnitudeRoundsToZero covers a valid
// trend whose magnitude is nonzero but displays as zero at fmtNum's
// precision (e.g. 0.04kg -> "0.0"). Without the guard this renders the
// self-contradictory "Down 0.0kg over 30 days".
func TestBuildNudges_NoWeightTrendWhenMagnitudeRoundsToZero(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -0.04, Days: 30, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown))
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp))
}

// TestBuildNudges_NoWeightTrendWhenSpanUnderADay covers a valid trend whose
// Days truncated to 0 (two entries inside the same 24h window). Without the
// guard this renders the self-contradictory "Down 0.3kg over 0 days".
func TestBuildNudges_NoWeightTrendWhenSpanUnderADay(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -0.3, Days: 0, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.False(t, hasKind(r.Nudges, NudgeKindWeightDown))
	require.False(t, hasKind(r.Nudges, NudgeKindWeightUp))
}

// TestBuildNudges_WeightTrendMinimumSpan pins the minWeightTrendSpanDays
// guard: a span shorter than 7 days is dominated by water-weight noise and
// must not be shown; 7 days and beyond must be.
func TestBuildNudges_WeightTrendMinimumSpan(t *testing.T) {
	tests := []struct {
		name      string
		days      int
		wantShown bool
	}{
		{"1 day is below the minimum", 1, false},
		{"6 days is below the minimum", 6, false},
		{"7 days meets the minimum", 7, true},
		{"30 days is well above the minimum", 30, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: tt.days, Valid: true}, 1800, 0)

			r := BuildNudges(c, SignalsFrom(c))

			require.Equal(t, tt.wantShown, hasKind(r.Nudges, NudgeKindWeightDown))
		})
	}
}

// TestDaysPhrase_SingularAndPlural pins the "1 day" vs "N days" grammar
// directly on the helper: minWeightTrendSpanDays keeps 1-day trends from
// ever reaching BuildNudges' output today, so the singular case can only be
// exercised at this level.
func TestDaysPhrase_SingularAndPlural(t *testing.T) {
	require.Equal(t, "0 days", daysPhrase(0))
	require.Equal(t, "1 day", daysPhrase(1))
	require.Equal(t, "7 days", daysPhrase(7))
	require.Equal(t, "30 days", daysPhrase(30))
}

// TestNudgeFromDecision_CollapsesKindOnSoften proves the Kind-sanitisation
// fix at the presentation-channel level. There are no restrictive
// candidates in production (see candidateNudges), so this drives the
// kind-collapse logic directly via the unexported nudgeFromDecision helper
// rather than authoring a restrictive candidate in candidateNudges.
func TestNudgeFromDecision_CollapsesKindOnSoften(t *testing.T) {
	d := guardrails.Evaluate(
		guardrails.Nudge{Title: "Fibre is low", Text: "Under target 4 days running", Restrictive: true},
		guardrails.Signals{}, // zero Signals == no data == not at risk -> Soften
	)
	require.Equal(t, guardrails.Soften, d.Action, "test setup must actually reach Soften")

	n := nudgeFromDecision(NudgeKindFibre, d)

	require.Equal(t, NudgeKindToday, n.Kind)
	require.Equal(t, guardrails.SoftenedTitle, n.Title)
	require.Equal(t, d.Text, n.Text, "text must be the softened reframe guardrails.Evaluate produced")
	require.NotEqual(t, NudgeKindFibre, n.Kind, "the original restrictive-flavoured kind must not survive Soften")
}

func TestBuildNudges_WeightGainPhrasedAsUp(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: 1.2, Days: 30, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, hasKind(r.Nudges, NudgeKindWeightUp))
	for _, n := range r.Nudges {
		if n.Kind == NudgeKindWeightUp {
			require.Contains(t, strings.ToLower(n.Text), "up")
		}
	}
}

// TestBuildNudges_CandidateOrderingWithAllPresent pins the candidate
// ordering contract documented on candidateNudges: protein, then fibre,
// then weight, when all three are present simultaneously. The upcoming
// home-screen entry card uses nudges[0] as the headline, so a silent
// reordering here would silently change what that card shows.
func TestBuildNudges_CandidateOrderingWithAllPresent(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 65}, // gap vs target -> protein candidate
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		AvgIntakeKcal: 1800,
		RecentDaily: []DailyTotal{
			// Kcal matches the 2000 target on every day so recentDeficitPct
			// stays 0 and AtRisk doesn't gate off the weight candidate below.
			{Kcal: 2000, FiberG: 10}, {Kcal: 2000, FiberG: 12}, {Kcal: 2000, FiberG: 10}, {Kcal: 2000, FiberG: 8},
			{Kcal: 2000, FiberG: 5}, {Kcal: 2000, FiberG: 5}, {Kcal: 2000, FiberG: 5}, // below-target streak -> fibre candidate
		},
		WeightTrend: WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, // -> weight candidate
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.Len(t, r.Nudges, 3, "test setup must produce all three candidates, got %+v", r.Nudges)
	require.Equal(t, NudgeKindProtein, r.Nudges[0].Kind)
	require.Equal(t, NudgeKindFibre, r.Nudges[1].Kind)
	require.Equal(t, NudgeKindWeightDown, r.Nudges[2].Kind)
}
