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
			{Kcal: 1000, LogCount: 1}, // deficit 0.5
			{Kcal: 2000, LogCount: 1}, // deficit 0
			{Kcal: 2500, LogCount: 1}, // over target -> clamped to 0
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

func TestRecentDeficitPct_ZeroWhenNothingLogged(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0},
		},
	}

	require.Equal(t, 0.0, recentDeficitPct(c),
		"no logs is absent data, not a 100% deficit")
}

func TestRecentDeficitPct_AveragesOnlyLoggedDays(t *testing.T) {
	// Two logged days at half target; the rest unlogged and ignored.
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 1000, LogCount: 2}, {Kcal: 1000, LogCount: 2},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
		},
	}

	require.InDelta(t, 0.5, recentDeficitPct(c), 0.001,
		"only days with evidence should contribute")
}

func TestRecentDeficitPct_LoggedZeroKcalDayStillCounts(t *testing.T) {
	// Logged, and it totalled zero — real evidence of not eating.
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 2000, LogCount: 3}, {Kcal: 0, LogCount: 1},
		},
	}

	require.InDelta(t, 0.5, recentDeficitPct(c), 0.001)
}

func TestRecentDeficitPct_StillFiresForRealUnderEating(t *testing.T) {
	// Consistent logging well under target must still trip the threshold.
	daily := make([]DailyTotal, 7)
	for i := range daily {
		daily[i] = DailyTotal{Kcal: 800, LogCount: 3}
	}
	c := Context{
		Today:       dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: daily,
	}

	require.Greater(t, recentDeficitPct(c), 0.30,
		"genuine sustained under-eating must still fire")
}
