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
	}

	r := BuildNudges(c, SignalsFrom(c))

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
			{FiberG: 40}, {FiberG: 40}, {FiberG: 40}, {FiberG: 40},
			{FiberG: 40}, {FiberG: 40}, {FiberG: 5}, // only today is below target
		},
	}

	r := BuildNudges(c, SignalsFrom(c))

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
			{FiberG: 0}, {FiberG: 0}, {FiberG: 0}, {FiberG: 0},
			{FiberG: 0}, {FiberG: 0}, {FiberG: 0},
		},
	}

	r := BuildNudges(c, SignalsFrom(c))

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
