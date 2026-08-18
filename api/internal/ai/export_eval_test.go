//go:build eval

package ai

// Export hooks for the eval harness ONLY.
//
// eval_ranking_test.go lives in package ai_test (see the note at the top of
// eval_test.go: package ai/providers imports package ai, so an in-package eval
// file that also imports providers would be an import cycle). The damping
// helpers it needs to report — phraseCoverage, reductionFactor, factorForTier,
// tierWithReduction — are unexported members of package ai.
//
// This is the standard export_test.go pattern: a test-only file compiled into
// the same test binary, so ai_test can reach the real implementations rather
// than reimplementing them. It carries the eval build tag so it does not even
// exist during an ordinary `go test`.

func EvalPhraseCoverage(phrase string, guesses []Guess) float64 {
	return phraseCoverage(phrase, guesses)
}

func EvalReductionFactor(coverage float64) float64 { return reductionFactor(coverage) }

func EvalFactorForTier(matchTier string, factor float64) float64 {
	return factorForTier(matchTier, factor)
}

func EvalTierWithReduction(identifyConf, matchScore, factor float64) Tier {
	return tierWithReduction(identifyConf, matchScore, factor)
}

// EvalPhraseCoverageFloor exposes the single constant the damping introduces so
// the harness can print it alongside the factors it produced.
const EvalPhraseCoverageFloor = phraseCoverageFloor
