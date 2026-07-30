package guardrails

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEvaluate_SuppressesRestrictiveNudgeUnderRisk(t *testing.T) {
	d := Evaluate(Nudge{Text: "You've eaten enough calories.", Restrictive: true},
		Signals{AvgIntakeKcal: 1100})
	require.Equal(t, Suppress, d.Action)
	require.True(t, d.ShowSupport)
	require.Empty(t, d.Text)
}

func TestEvaluate_SoftensRestrictiveNudgeNoRisk(t *testing.T) {
	d := Evaluate(Nudge{Text: "You've eaten enough.", Restrictive: true},
		Signals{AvgIntakeKcal: 2000, RecentDeficitPct: 0.1})
	require.Equal(t, Soften, d.Action)
	require.NotEmpty(t, d.Text)
	require.NotContains(t, d.Text, "enough")
}

func TestEvaluate_AllowsSupportiveNudge(t *testing.T) {
	d := Evaluate(Nudge{Text: "35g protein to go — a yoghurt would do it.", Restrictive: false},
		Signals{AvgIntakeKcal: 2000})
	require.Equal(t, Allow, d.Action)
	require.Equal(t, "35g protein to go — a yoghurt would do it.", d.Text)
}

func TestEvaluate_RiskThresholds(t *testing.T) {
	for _, s := range []Signals{{RecentDeficitPct: 0.30}, {AvgIntakeKcal: 1200}, {LogsPerDay: 12}, {FastingStreakDays: 3}} {
		require.Equal(t, Suppress, Evaluate(Nudge{Restrictive: true}, s).Action)
	}
}

// TestEvaluate_RiskAllowsSupportiveNudge covers the "risk fires, not
// restrictive" branch: supportive nudges are still allowed through even
// when a risk signal is present.
func TestEvaluate_RiskAllowsSupportiveNudge(t *testing.T) {
	d := Evaluate(Nudge{Text: "You're doing great, keep it up.", Restrictive: false},
		Signals{FastingStreakDays: 3})
	require.Equal(t, Allow, d.Action)
	require.Equal(t, "You're doing great, keep it up.", d.Text)
}

// TestEvaluate_ZeroValueSignalsIsNotRisk asserts the zero-value Signals{}
// (i.e. "no data available") does not itself count as risk from the
// AvgIntakeKcal<=1200 rule — only a positive, non-zero intake at or below
// the threshold should fire.
func TestEvaluate_ZeroValueSignalsIsNotRisk(t *testing.T) {
	d := Evaluate(Nudge{Text: "Great job logging today.", Restrictive: false}, Signals{})
	require.Equal(t, Allow, d.Action)
	require.Equal(t, "Great job logging today.", d.Text)
}

// TestEvaluate_JustBelowThresholdsIsNotRisk checks values just under each
// threshold do not trigger Suppress for a restrictive nudge.
func TestEvaluate_JustBelowThresholdsIsNotRisk(t *testing.T) {
	for _, s := range []Signals{
		{RecentDeficitPct: 0.29},
		{AvgIntakeKcal: 1201},
		{LogsPerDay: 11.9},
		{FastingStreakDays: 2},
	} {
		d := Evaluate(Nudge{Text: "You've eaten enough.", Restrictive: true}, s)
		require.Equal(t, Soften, d.Action)
	}
}

// TestAtRisk verifies the AtRisk predicate for coach support surfacing.
func TestAtRisk(t *testing.T) {
	require.True(t, AtRisk(Signals{AvgIntakeKcal: 1100}))
	require.True(t, AtRisk(Signals{FastingStreakDays: 3}))
	require.False(t, AtRisk(Signals{}))                 // zero value = no data
	require.False(t, AtRisk(Signals{AvgIntakeKcal: 2000}))
}
