package coach

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/dashboard"
)

func TestSignalsFrom(t *testing.T) {
	c := Context{
		RecentDaily:       []DailyTotal{{Kcal: 1000, LogCount: 1}, {Kcal: 1200, LogCount: 2}},
		AvgIntakeKcal:     1100,
		LogsPerDay:        1.5,
		FastingStreakDays: 0,
	}

	s := SignalsFrom(c)
	require.InDelta(t, 1100, s.AvgIntakeKcal, 0.01)
	require.InDelta(t, 1.5, s.LogsPerDay, 0.01)
	require.Equal(t, 0, s.FastingStreakDays)
	// Today.Targets.Kcal is zero-value here, so there is no positive target
	// to measure a deficit against.
	require.InDelta(t, 0, s.RecentDeficitPct, 0.0001)
}

func TestSignalsFromComputesRecentDeficitPctAgainstTodayTarget(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 1000}, // deficit 0.5
			{Kcal: 2000}, // deficit 0
			{Kcal: 2500}, // over target -> clamped to 0
		},
	}

	s := SignalsFrom(c)
	// mean(0.5, 0, 0) = 0.1666...
	require.InDelta(t, 0.16667, s.RecentDeficitPct, 0.001)
}

func TestSignalsFromPassesThroughFastingStreak(t *testing.T) {
	c := Context{FastingStreakDays: 4}
	s := SignalsFrom(c)
	require.Equal(t, 4, s.FastingStreakDays)
}
