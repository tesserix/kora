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

// recentDeficitPct is the mean clamped shortfall vs today's kcal target
// across the days in c.RecentDaily the user ACTUALLY LOGGED.
//
// Unlogged days are excluded rather than scored as a full deficit. A day
// with no logs is absent data, not evidence of not eating — scoring it as a
// 100% shortfall meant a brand-new user with seven empty days averaged a
// 1.0 deficit and tripped the ED-risk threshold on first use. guardrails.AtRisk
// applies the same reasoning to AvgIntakeKcal ("zero means no data").
//
// A day the user logged on that still totals zero kcal DOES count — that is
// observed intake, not missing data.
//
// If the target is not positive (not onboarded) or nothing was logged in the
// window, there is nothing to measure a shortfall against, so this reports 0
// rather than a misleading spike.
func recentDeficitPct(c Context) float64 {
	target := c.Today.Targets.Kcal
	if target <= 0 || len(c.RecentDaily) == 0 {
		return 0
	}
	var sum float64
	var logged int
	for _, d := range c.RecentDaily {
		if d.LogCount == 0 {
			continue
		}
		deficit := 1 - d.Kcal/target
		switch {
		case deficit < 0:
			deficit = 0
		case deficit > 1:
			deficit = 1
		}
		sum += deficit
		logged++
	}
	if logged == 0 {
		return 0
	}
	return sum / float64(logged)
}
