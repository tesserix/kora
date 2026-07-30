package coach

import (
	"fmt"

	"github.com/tesserix/kora/api/internal/guardrails"
)

// minFiberBelowTargetStreakDays is the minimum number of consecutive most-
// recent days (today counting backward) that fibre intake must sit below
// c.Today.Targets.FiberG before a "fibre low" nudge is surfaced. This avoids
// nudging off a single off day.
const minFiberBelowTargetStreakDays = 2

// Nudge is a coach message that survived the Protective guardrail policy,
// ready to show to the user.
type Nudge struct {
	Text   string
	Reason string
}

// NudgeResult is the outcome of BuildNudges: the surviving nudges plus
// whether a supportive resource should be surfaced instead of/alongside them.
type NudgeResult struct {
	Nudges      []Nudge
	ShowSupport bool
}

// BuildNudges derives additive coach nudge candidates from c, runs each
// through the Protective guardrails.Evaluate policy against s, and returns
// the surviving (Allow/Soften) nudges. Suppressed candidates are dropped.
//
// Every candidate this function authors is additive (Restrictive: false) —
// it never suggests eating less, stopping, or restricting. That is a
// deliberate invariant, not an oversight: see
// TestBuildNudges_NoSurvivingRestrictiveUnderRisk.
func BuildNudges(c Context, s guardrails.Signals) NudgeResult {
	candidates := candidateNudges(c)

	nudges := make([]Nudge, 0, len(candidates))
	for _, cand := range candidates {
		d := guardrails.Evaluate(cand, s)
		if d.Action == guardrails.Suppress {
			continue
		}
		nudges = append(nudges, Nudge{Text: d.Text, Reason: d.Reason})
	}

	return NudgeResult{
		Nudges:      nudges,
		ShowSupport: guardrails.AtRisk(s),
	}
}

// candidateNudges builds the ordered set of additive nudge candidates from
// c. Every candidate has Restrictive: false — this function must never
// author one that steers toward eating less.
func candidateNudges(c Context) []guardrails.Nudge {
	var candidates []guardrails.Nudge

	if n, ok := proteinGapNudge(c); ok {
		candidates = append(candidates, n)
	}
	if n, ok := fiberLowStreakNudge(c); ok {
		candidates = append(candidates, n)
	}

	return candidates
}

// proteinGapNudge surfaces today's remaining protein need when the target
// hasn't been met yet. Additive by construction: it only ever asks for more
// protein, never less.
func proteinGapNudge(c Context) (guardrails.Nudge, bool) {
	gap := c.Today.Targets.ProteinG - c.Today.Consumed.ProteinG
	if gap <= 0 {
		return guardrails.Nudge{}, false
	}
	return guardrails.Nudge{
		Text:        fmt.Sprintf("%sg protein to go", fmtNum(gap)),
		Restrictive: false,
	}, true
}

// fiberLowStreakNudge surfaces a streak of days with fibre intake below
// target, once the streak reaches minFiberBelowTargetStreakDays. Additive by
// construction: it flags a shortfall to close, not an excess to cut.
func fiberLowStreakNudge(c Context) (guardrails.Nudge, bool) {
	streak := fiberBelowTargetStreak(c)
	if streak < minFiberBelowTargetStreakDays {
		return guardrails.Nudge{}, false
	}
	return guardrails.Nudge{
		Text:        fmt.Sprintf("fibre low %d days", streak),
		Restrictive: false,
	}, true
}

// fiberBelowTargetStreak counts consecutive days in c.RecentDaily, most
// recent (today) backward, with FiberG below c.Today.Targets.FiberG. If no
// fibre target is set (<= 0), there is nothing to measure a shortfall
// against, so it reports 0 rather than a misleading streak.
func fiberBelowTargetStreak(c Context) int {
	target := c.Today.Targets.FiberG
	if target <= 0 {
		return 0
	}
	streak := 0
	for i := len(c.RecentDaily) - 1; i >= 0; i-- {
		if c.RecentDaily[i].FiberG >= target {
			break
		}
		streak++
	}
	return streak
}
