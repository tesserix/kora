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

// NudgeKind classifies a nudge so the client can pick an icon and accent
// without the server shipping presentation details.
type NudgeKind string

const (
	NudgeKindProtein     NudgeKind = "protein"
	NudgeKindFibre       NudgeKind = "fibre"
	NudgeKindWeightTrend NudgeKind = "weight_trend"
)

// Nudge is a coach message that survived the Protective guardrail policy,
// ready to show to the user.
type Nudge struct {
	Kind  NudgeKind `json:"kind"`
	Title string    `json:"title"`
	Text  string    `json:"text"`
	// Reason explains which policy branch fired. It is an internal audit
	// string — never render it to users.
	Reason string `json:"reason"`
}

// candidate pairs a policy-evaluable nudge with the kind it will carry
// once it survives evaluation. guardrails.Nudge has no notion of kind, so
// kind is carried alongside the policy input rather than through it.
type candidate struct {
	kind  NudgeKind
	nudge guardrails.Nudge
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
	candidates := candidateNudges(c, s)

	nudges := make([]Nudge, 0, len(candidates))
	for _, cand := range candidates {
		d := guardrails.Evaluate(cand.nudge, s)
		if d.Action == guardrails.Suppress {
			continue
		}
		nudges = append(nudges, Nudge{
			Kind:   cand.kind,
			Title:  d.Title,
			Text:   d.Text,
			Reason: d.Reason,
		})
	}

	return NudgeResult{
		Nudges:      nudges,
		ShowSupport: guardrails.AtRisk(s),
	}
}

// candidateNudges builds the ordered set of additive nudge candidates from
// c. Every candidate has Restrictive: false — this function must never
// author one that steers toward eating less.
func candidateNudges(c Context, s guardrails.Signals) []candidate {
	var candidates []candidate

	if n, ok := proteinGapNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindProtein, nudge: n})
	}
	if n, ok := fiberLowStreakNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindFibre, nudge: n})
	}
	// The weight trend is gated on risk rather than marked Restrictive:
	// a restrictive candidate would be Softened into the fixed reframe for
	// every non-at-risk user, destroying the card for its whole audience.
	// Gating keeps weight-loss framing away from at-risk users while
	// leaving it intact for everyone else.
	if !guardrails.AtRisk(s) {
		if n, ok := weightTrendNudge(c); ok {
			candidates = append(candidates, candidate{kind: NudgeKindWeightTrend, nudge: n})
		}
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
		Title: "Protein",
		Text: fmt.Sprintf("%s / %sg — %sg to go",
			fmtNum(c.Today.Consumed.ProteinG), fmtNum(c.Today.Targets.ProteinG), fmtNum(gap)),
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
		Title:       "Fibre is low",
		Text:        fmt.Sprintf("Under target %d days running", streak),
		Restrictive: false,
	}, true
}

// weightTrendNudge surfaces the observed weight change over the trailing
// weightWindowDays. It states only what was logged: no projection, no goal
// framing. Callers must gate it on !guardrails.AtRisk — see candidateNudges.
func weightTrendNudge(c Context) (guardrails.Nudge, bool) {
	tr := c.WeightTrend
	if !tr.Valid {
		return guardrails.Nudge{}, false
	}
	direction := "Up"
	magnitude := tr.DeltaKg
	if tr.DeltaKg < 0 {
		direction = "Down"
		magnitude = -tr.DeltaKg
	}
	// Skip when the magnitude would display as zero (e.g. a 0.04kg delta
	// rounds to "0.0" at fmtNumDisplayPrecision): pairing a direction word
	// with a zero-looking magnitude reads as self-contradictory ("Down
	// 0.0kg"), not just uninformative. Deriving the check from fmtNum
	// itself keeps this correct if the display precision ever changes.
	if fmtNum(magnitude) == "0" {
		return guardrails.Nudge{}, false
	}
	// Skip when the trend spans less than a day. Days is an elapsed-
	// hours/24 truncation, so two entries inside the same 24h window
	// produce Days: 0, which would render the self-contradictory "over 0
	// days".
	if tr.Days < 1 {
		return guardrails.Nudge{}, false
	}
	return guardrails.Nudge{
		Title:       "Weight trend",
		Text:        fmt.Sprintf("%s %skg over %d days", direction, fmtNum(magnitude), tr.Days),
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
