package ai

import "github.com/tesserix/kora/api/internal/nutrition"

// phraseCoverageFloor is the confidence multiplier applied when the guesses
// account for NONE of what the user said. It is ONE constant, and the only one
// this mechanism introduces, held to the same standard as the weights in
// nutrition/score.go: stated from principle, not fitted to a golden set.
//
// The principle: when nothing the user said survives into the guesses, the
// engine is no longer answering the question it was asked. Whatever the index
// matched, it is at best an even chance that it is the right food — so half the
// claimed confidence is the most that can be honestly reported. 0.5 is that
// "coin flip", not a tuned value; it is deliberately NOT the 0.6 of
// ambiguityFloor, because ambiguity means "one of these is right and I can't
// tell which", while zero phrase coverage means "the right one may not be here
// at all". The second is the worse position, so it damps harder.
//
// Consequence, with identify's measured 0.95 confidence on both #184 failures:
// zero coverage lands at 0.475 (follow_up, below the 0.70 confirm floor), and
// losing just a brand off six tokens lands at 0.79 (confirm, no longer a
// one-tap auto-log). Both are what those two productions cases needed, and both
// fall out of the single constant rather than being fitted to it.
const phraseCoverageFloor = 0.5

// phraseCoverage reports how much of the user's phrase the guesses
// collectively account for. A token is accounted-for when it appears in ANY
// guess's Food, PortionEstimate or CookingMethod:
//
//   - Food is the obvious one.
//   - PortionEstimate matters because identify genuinely preserves quantities
//     there — a live call on "El Janah 1/2 chicken with Chips" returned
//     PortionEstimate "1/2" (see summariseGuesses and ca9e2de). Penalising the
//     phrase for a "1/2" the model DID keep would measure the wrong loss.
//   - CookingMethod is included for exactly the same reason: "grilled" moved
//     out of Food into its own field is information kept, not information
//     discarded.
//
// The phrase is empty on the photo path, where PhraseCoverage returns 1 and the
// whole mechanism becomes a no-op.
func phraseCoverage(phrase string, guesses []Guess) float64 {
	accounted := make([]string, 0, len(guesses)*3)
	for _, g := range guesses {
		accounted = append(accounted, g.Food, g.PortionEstimate, g.CookingMethod)
	}
	return nutrition.PhraseCoverage(phrase, accounted)
}

// reductionFactor turns phrase coverage into a confidence multiplier: a
// straight line from phraseCoverageFloor at zero coverage to exactly 1.0 at
// full coverage.
//
// Shape chosen over the simpler alternative — a hard "never auto below some
// coverage" cap — because a cap cannot express the second measured failure.
// "McSpicy chicken meal" resolved to French Fries and an energy drink, foods
// the user never named; a cap would demote that to confirm, i.e. still
// loggable in one tap after a glance. It has to fall to follow_up, and only a
// multiplier can carry it that far. The line mirrors ambiguityFactor's
// floor+slope form, but with the slope DERIVED from the floor (1 - floor)
// rather than being a second free parameter, so full coverage is exactly 1.0
// and a fully-accounted-for phrase provably pays nothing.
func reductionFactor(coverage float64) float64 {
	f := phraseCoverageFloor + (1-phraseCoverageFloor)*coverage
	if f < phraseCoverageFloor {
		return phraseCoverageFloor
	}
	if f > 1 {
		return 1
	}
	return f
}

// tierWithReduction is TierFor with the reduction factor applied. Both inputs
// are scaled, which — since TierFor takes their MIN and the factor is
// non-negative — is exactly scaling that min: the damping changes how far the
// confidence moves, never WHICH of the two signals is the limiting one.
//
// MatchScore itself is deliberately left undamped on the ResolvedCandidate: it
// reports how well that row matched the string it was searched with, and
// minReturnableMatchScore's floor was measured against those raw values. Only
// the tier — the claim "this is safe to log without asking" — is reduced.
func tierWithReduction(identifyConf, matchScore, factor float64) Tier {
	return TierFor(identifyConf*factor, matchScore*factor)
}
