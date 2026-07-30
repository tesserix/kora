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

// minWeightTrendSpanDays is the minimum number of days a weight trend must
// span before it is stated. A shorter span is dominated by day-to-day
// water-weight fluctuation (see the weightWindowDays comment in
// grounding.go), so it is not a trend worth stating — e.g. two weigh-ins 25
// hours apart would otherwise render "Down 0.9kg over 1 day", which is
// exactly the noise the 30-day window was chosen to avoid.
const minWeightTrendSpanDays = 7

// NudgeKind classifies a nudge so the client can pick an icon and accent
// without the server shipping presentation details.
type NudgeKind string

const (
	NudgeKindProtein NudgeKind = "protein"
	NudgeKindFibre   NudgeKind = "fibre"
	// NudgeKindWeightDown and NudgeKindWeightUp split the weight-trend card
	// by observed direction so the client can pick the right arrow/icon
	// without string-matching server copy. Neither should be rendered with
	// a celebratory or shaming accent — this is an ED-sensitive surface, and
	// both a gain and a loss must use the same neutral accent.
	NudgeKindWeightDown NudgeKind = "weight_down"
	NudgeKindWeightUp   NudgeKind = "weight_up"
	// NudgeKindToday is the neutral kind paired with a softened nudge: it
	// matches guardrails.SoftenedTitle, so a Softened candidate never
	// carries its original (now-contradictory) kind through to the client.
	NudgeKindToday NudgeKind = "today"
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
		nudges = append(nudges, nudgeFromDecision(cand.kind, d))
	}

	return NudgeResult{
		Nudges:      nudges,
		ShowSupport: guardrails.AtRisk(s),
	}
}

// nudgeFromDecision converts a surviving (Allow/Soften) candidate and its
// guardrails.Decision into the Nudge to surface. Kind collapses to the
// neutral NudgeKindToday on Soften, matching Title's collapse to
// guardrails.SoftenedTitle inside Evaluate itself — kind is otherwise
// passed straight through unmodified for Allow.
func nudgeFromDecision(kind NudgeKind, d guardrails.Decision) Nudge {
	if d.Action == guardrails.Soften {
		kind = NudgeKindToday
	}
	return Nudge{
		Kind:   kind,
		Title:  d.Title,
		Text:   d.Text,
		Reason: d.Reason,
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
		if kind, n, ok := weightTrendNudge(c); ok {
			candidates = append(candidates, candidate{kind: kind, nudge: n})
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
// The returned NudgeKind carries the observed direction (see
// NudgeKindWeightDown/NudgeKindWeightUp) so candidateNudges can attach it
// to the candidate.
func weightTrendNudge(c Context) (NudgeKind, guardrails.Nudge, bool) {
	tr := c.WeightTrend
	if !tr.Valid {
		return "", guardrails.Nudge{}, false
	}
	direction := "Up"
	kind := NudgeKindWeightUp
	magnitude := tr.DeltaKg
	if tr.DeltaKg < 0 {
		direction = "Down"
		kind = NudgeKindWeightDown
		magnitude = -tr.DeltaKg
	}
	// Skip when the magnitude would display as zero (e.g. a 0.04kg delta
	// rounds to "0.0" at fmtNumDisplayPrecision): pairing a direction word
	// with a zero-looking magnitude reads as self-contradictory ("Down
	// 0.0kg"), not just uninformative. Deriving the check from fmtNum
	// itself keeps this correct if the display precision ever changes.
	if fmtNum(magnitude) == "0" {
		return "", guardrails.Nudge{}, false
	}
	// Skip when the trend spans fewer than minWeightTrendSpanDays: a
	// shorter span (including Days: 0, an elapsed-hours/24 truncation for
	// two entries inside the same 24h window) is dominated by water-weight
	// noise, not a trend worth stating.
	if tr.Days < minWeightTrendSpanDays {
		return "", guardrails.Nudge{}, false
	}
	return kind, guardrails.Nudge{
		Title:       "Weight trend",
		Text:        fmt.Sprintf("%s %skg over %s", direction, fmtNum(magnitude), daysPhrase(tr.Days)),
		Restrictive: false,
	}, true
}

// daysPhrase renders an elapsed-days count with correct singular/plural
// grammar: "1 day" vs "N days".
func daysPhrase(days int) string {
	if days == 1 {
		return "1 day"
	}
	return fmt.Sprintf("%d days", days)
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
