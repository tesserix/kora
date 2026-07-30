package coach

import "github.com/tesserix/kora/api/internal/guardrails"

// SignalsFrom derives guardrails.Signals from a grounded Context. It is a
// pure computation over already-fetched, real data — no new reads happen
// here.
func SignalsFrom(c Context) guardrails.Signals {
	return guardrails.Signals{
		RecentDeficitPct:  recentDeficitPct(c),
		AvgIntakeKcal:     c.AvgIntakeKcal,
		LogsPerDay:        c.LogsPerDay,
		FastingStreakDays: c.FastingStreakDays,
	}
}

// recentDeficitPct is the mean of clamp(1 - dayKcal/targetKcal, 0, 1) over
// c.RecentDaily, using today's kcal target as the reference. If the target
// is not positive (no data / not onboarded), there is nothing to measure a
// deficit against, so it reports 0 rather than a misleading spike.
func recentDeficitPct(c Context) float64 {
	target := c.Today.Targets.Kcal
	if target <= 0 || len(c.RecentDaily) == 0 {
		return 0
	}
	var sum float64
	for _, d := range c.RecentDaily {
		deficit := 1 - d.Kcal/target
		switch {
		case deficit < 0:
			deficit = 0
		case deficit > 1:
			deficit = 1
		}
		sum += deficit
	}
	return sum / float64(len(c.RecentDaily))
}
