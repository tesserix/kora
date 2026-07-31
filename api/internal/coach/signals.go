package coach

import "github.com/tesserix/kora/api/internal/guardrails"

// minDeficitLoggedDays is the fewest COMPLETE (non-today) logged days
// recentDeficitPct requires before it will report a non-zero deficit. Below
// this, one abandoned or partial logging day would stand in for the whole
// window's "average deficit" — the same single-sample-as-signal problem the
// today-exclusion fixes for today specifically, but that a lone logged day
// anywhere else in the window still reproduces. Mirrors guardrails.AtRisk's
// existing AvgIntakeKcal > 0 guard: too little evidence must read as "no
// data", not as a spike.
const minDeficitLoggedDays = 2

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
// across the days in c.RecentDaily the user ACTUALLY LOGGED, excluding
// today. See fastingStreak's doc comment (grounding.go, same package) for
// the full shared rationale — this function and summarizeRecent's avgKcal
// both apply the identical exclude-today / logged-days-only rule stated
// there.
//
// Concretely: without the today-exclusion, a brand-new user whose only log
// is one partial meal earlier today has exactly one logged day in the
// window — today — and that partial reading becomes the entire deficit
// signal (e.g. target 2000, one 450 kcal breakfast: deficit = 1 - 450/2000 =
// 0.775), tripping the ED-risk threshold on their very first log.
//
// If the target is not positive (not onboarded), nothing complete was
// logged in the window, or fewer than minDeficitLoggedDays complete days
// were logged, there is not enough evidence to measure a shortfall against,
// so this reports 0 rather than a misleading spike.
func recentDeficitPct(c Context) float64 {
	target := c.Today.Targets.Kcal
	if target <= 0 || len(c.RecentDaily) == 0 {
		return 0
	}
	// Exclude today (the last entry): it is incomplete.
	complete := c.RecentDaily[:len(c.RecentDaily)-1]

	var sum float64
	var logged int
	for _, d := range complete {
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
	if logged < minDeficitLoggedDays {
		return 0
	}
	return sum / float64(logged)
}
