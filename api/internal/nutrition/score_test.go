package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTokenOverlap(t *testing.T) {
	tests := []struct {
		name              string
		query, doc        string
		wantCov, wantPrec float64
	}{
		{"exact", "chicken breast", "chicken breast", 1.0, 1.0},
		{"doc has extra terms", "chicken breast", "fast food fried chicken breast", 1.0, 0.4},
		{"query has extra terms", "grilled chicken breast", "chicken breast", 2.0 / 3.0, 1.0},
		{"no shared terms", "paneer", "chicken breast", 0, 0},
		{"empty query", "", "chicken breast", 0, 0},
		{"empty doc", "chicken breast", "", 0, 0},
		{"duplicate terms counted once", "chicken chicken", "chicken", 1.0, 1.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cov, prec := tokenOverlap(tt.query, tt.doc)
			require.InDelta(t, tt.wantCov, cov, 0.001, "coverage")
			require.InDelta(t, tt.wantPrec, prec, 0.001, "precision")
		})
	}
}

func TestLexicalRanksTheRealFailureCase(t *testing.T) {
	// The exact prod case: ts_rank gave all of these 0.09910. Whatever else
	// changes, the ordering below must hold.
	exact := lexical(components{Coverage: 1, Precision: 1, Trigram: 1.000})
	roasted := lexical(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.682})
	grilled := lexical(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.652})
	friedShort := lexical(components{Coverage: 1, Precision: 0.400, Trigram: 0.556})
	friedLong := lexical(components{Coverage: 1, Precision: 0.222, Trigram: 0.278})

	require.Greater(t, exact, roasted)
	require.Greater(t, roasted, grilled)
	require.Greater(t, grilled, friedShort)
	require.Greater(t, friedShort, friedLong)
	require.InDelta(t, 1.0, exact, 0.001)
}

func TestQualityEmbeddingIsABoosterNeverAPenalty(t *testing.T) {
	// The load-bearing property: a row with no embedding must score exactly
	// its lexical value. 302 of 7,856 prod rows are embedded, so if a missing
	// embedding could lower a score, coverage gaps would distort every
	// comparison.
	c := components{Coverage: 1, Precision: 0.5, Trigram: 0.6, EmbSim: 0}
	require.InDelta(t, lexical(c), quality(c), 0.0001)

	// A strong semantic match lifts a weak lexical one.
	weak := components{Coverage: 0, Precision: 0, Trigram: 0.1, EmbSim: 0.9}
	require.InDelta(t, 0.85*0.9, quality(weak), 0.0001)

	// ...but never drags a strong lexical match down.
	strong := components{Coverage: 1, Precision: 1, Trigram: 1, EmbSim: 0.1}
	require.InDelta(t, 1.0, quality(strong), 0.0001)
}

func TestQualityStaysInUnitInterval(t *testing.T) {
	max := quality(components{Coverage: 1, Precision: 1, Trigram: 1, EmbSim: 1})
	require.LessOrEqual(t, max, 1.0)
	min := quality(components{})
	require.GreaterOrEqual(t, min, 0.0)
}

func TestAmbiguityFactor(t *testing.T) {
	require.InDelta(t, 0.6, ambiguityFactor(0), 0.001)       // dead tie
	require.InDelta(t, 0.618, ambiguityFactor(0.009), 0.001) // the prod near-tie
	require.InDelta(t, 1.0, ambiguityFactor(0.2), 0.001)     // clearly separated
	require.InDelta(t, 1.0, ambiguityFactor(5), 0.001)       // clamped above
	require.InDelta(t, 0.6, ambiguityFactor(-1), 0.001)      // clamped below
}

func TestScoringSeparatesTheAmbiguousFromTheClear(t *testing.T) {
	// This is the whole point of the change, expressed as one test.
	exact := quality(components{Coverage: 1, Precision: 1, Trigram: 1.000})
	roasted := quality(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.682})
	grilled := quality(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.652})

	// Index contains an exact row → confident.
	clear := exact * ambiguityFactor(exact-roasted)
	require.Greater(t, clear, 0.90, "an exact match with a clear runner-up must reach auto")

	// Prod index has no exact row, just near-identical variants → uncertain.
	ambiguous := roasted * ambiguityFactor(roasted-grilled)
	require.Less(t, ambiguous, 0.70, "near-tied candidates must fall to follow_up")
}
