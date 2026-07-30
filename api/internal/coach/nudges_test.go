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
	require.Contains(t, r.Nudges[0].Text, "protein")
	require.Contains(t, r.Nudges[0].Text, "55")
	require.NotEmpty(t, r.Nudges[0].Reason)
	require.False(t, r.ShowSupport)
}

func TestBuildNudges_NoProteinGapWhenTargetMet(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	for _, n := range r.Nudges {
		require.NotContains(t, n.Text, "protein")
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
		if strings.Contains(n.Text, "fibre low") {
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
			{FiberG: 40}, {FiberG: 40}, {FiberG: 40}, {FiberG: 40},
			{FiberG: 40}, {FiberG: 40}, {FiberG: 5}, // only today is below target
		},
	}

	r := BuildNudges(c, SignalsFrom(c))

	for _, n := range r.Nudges {
		require.NotContains(t, n.Text, "fibre low")
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
			{FiberG: 0}, {FiberG: 0}, {FiberG: 0}, {FiberG: 0},
			{FiberG: 0}, {FiberG: 0}, {FiberG: 0},
		},
	}

	r := BuildNudges(c, SignalsFrom(c))

	for _, n := range r.Nudges {
		require.NotContains(t, n.Text, "fibre low")
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
