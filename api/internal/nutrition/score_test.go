package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTokenOverlap(t *testing.T) {
	// identity defaults to doc where a case does not set it, which is the
	// no-comma shape: a natural-English name has no qualifier tail to strip.
	tests := []struct {
		name              string
		query, doc        string
		identity          string
		wantCov, wantPrec float64
	}{
		{"exact", "chicken breast", "chicken breast", "", 1.0, 1.0},
		{"doc has extra terms", "chicken breast", "fast food fried chicken breast", "", 1.0, 0.4},
		{"query has extra terms", "grilled chicken breast", "chicken breast", "", 2.0 / 3.0, 1.0},
		{"no shared terms", "paneer", "chicken breast", "", 0, 0},
		{"empty query", "", "chicken breast", "", 0, 0},
		{"empty doc", "chicken breast", "", "", 0, 0},
		{"duplicate terms counted once", "chicken chicken", "chicken", "", 1.0, 1.0},
		// kora#219: coverage still sees the whole document, but precision is
		// charged only against the identity, so a carefully-qualified name is
		// no longer penalised for its tail.
		{
			// Inputs are already-Normalize()d, which singularizes: "chips" -> "chip".
			"qualifier tail does not dilute precision",
			"chip", "potato chip regular fast food outlet deep fried blended oil salted",
			"potato chip", 1.0, 0.5,
		},
		{
			"a query term found only in the tail counts for coverage, not precision",
			"salted", "potato chip regular salted", "potato chip", 1.0, 0.0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			identity := tt.identity
			if identity == "" {
				identity = tt.doc
			}
			cov, prec := tokenOverlap(tt.query, tt.doc, identity)
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

func TestHeadToken(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"USDA comma name", "Almonds, raw", "almond"},
		{"USDA multi-descriptor", "Beef, cured, dried", "beef"},
		{"multi-word pre-comma segment", "Greek yogurt, plain, nonfat", "yogurt"},
		{"USDA derivative — head is the descriptor, not the food", "Oil, almond", "oil"},
		{"comma-inverted derivative product", "Strudel, apple", "strudel"},
		{"no-comma curated name, head-final", "Wholemeal bread", "bread"},
		{"no-comma curated dish", "Chicken biryani", "biryani"},
		{"single-word name", "Salmon", "salmon"},
		{"empty name", "", ""},
		{"punctuation-only name", ",,,", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, headToken(tt.raw))
		})
	}
}

func TestIdentityPhraseDropsTheQualifierTail(t *testing.T) {
	require.Equal(t, "potato chip",
		identityPhrase("Potato, chips, regular, fast food outlet, deep fried, blended oil, salted"))
	require.Equal(t, "banana chip", identityPhrase("Banana chip"), "a no-comma name is its own identity")
	require.Equal(t, "cheese cheddar", identityPhrase("Cheese, cheddar"))
	require.Equal(t, "", identityPhrase(""))
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

// TestAmbiguityMarginIgnoresRankOrder is the guard for kora#212's invariant:
// discounting or promoting a rival must never raise the survivor's confidence.
//
// The pool is passed in an order that a ranking bonus would have produced, with
// the true runner-up pushed into third place. If the margin were read off the
// ranked list it would be 0.95-0.75 = 0.20 (factor 1.00, `auto`); the correct
// answer is 0.95-0.85 = 0.10 (factor 0.80), because A's real rival C is still
// sitting there at 0.85 and nothing about A actually improved.
func TestAmbiguityMarginIgnoresRankOrder(t *testing.T) {
	byScore := []*scoredItem{{score: 0.95}, {score: 0.85}, {score: 0.75}}
	// The same three rows as a ranking signal would order them: the 0.75 row
	// has been promoted above the 0.85 row. The presented answer (0.95) is
	// unchanged, so its confidence must be too.
	reordered := []*scoredItem{{score: 0.95}, {score: 0.75}, {score: 0.85}}

	require.InDelta(t, 0.10, ambiguityMargin(byScore), 1e-9)
	require.InDelta(t, 0.10, ambiguityMargin(reordered), 1e-9,
		"the margin must be a property of the candidate set, not of the presentation order")
	require.Equal(t, ambiguityMargin(byScore), ambiguityMargin(reordered))

	// And the consequence that actually matters: the tier-driving factor is
	// unchanged by the reorder, so promoting a weaker row cannot manufacture
	// confidence.
	require.InDelta(t, 0.80, ambiguityFactor(ambiguityMargin(reordered)), 1e-9)
}

func TestAmbiguityMarginHandlesShortAndTiedPools(t *testing.T) {
	// A pool with no rival must NOT be damped: ambiguityFactorFor short-circuits
	// to 1.0. Routing it through ambiguityMargin instead would read as a dead
	// tie and floor an unambiguous single answer at 0.6.
	require.InDelta(t, 1.0, ambiguityFactorFor(nil), 1e-9)
	require.InDelta(t, 1.0, ambiguityFactorFor([]*scoredItem{{score: 0.9}}), 1e-9,
		"one candidate and no rival is the least ambiguous case, not the most")
	require.Zero(t, ambiguityMargin([]*scoredItem{{score: 0.6}, {score: 0.6}}),
		"a genuine tie is zero margin")
	require.InDelta(t, 0.6, ambiguityFactorFor([]*scoredItem{{score: 0.6}, {score: 0.6}}), 1e-9,
		"a real tie between two candidates must land on the ambiguity floor")
}

// TestAmbiguityMarginFloorsAPromotedWeakerWinner is the other half of the
// invariant, and the direction an earlier attempt at this got backwards.
//
// headBonus deliberately promotes a lower-quality row to top-1. When it does,
// the row being reported is WEAKER than a rival still in the pool, which is the
// least confident situation there is. Measuring the gap between the top two
// qualities regardless of which is presented would report this as a clear win
// and raise confidence; keeping items[0] as the subject yields a negative
// margin that clamps to 0 and floors it.
func TestAmbiguityMarginFloorsAPromotedWeakerWinner(t *testing.T) {
	promoted := []*scoredItem{{score: 0.60}, {score: 0.80}}
	require.Zero(t, ambiguityMargin(promoted),
		"a presented row that is weaker than its rival must not earn a positive margin")
	require.InDelta(t, 0.6, ambiguityFactorFor(promoted), 1e-9,
		"it must land on the ambiguity floor, not above it")
}

// TestQueryNamesABrandRequiresTheWholeBrand pins the gate on Phase 2's
// generic-preference policy. The failure mode it guards is specific: brands
// routinely contain ordinary food words, so a match-any-token rule would read
// the bare query "soup" as naming a brand and switch off the preference for
// exactly the query that needs it.
func TestQueryNamesABrandRequiresTheWholeBrand(t *testing.T) {
	pool := func(brands ...string) []*scoredItem {
		out := make([]*scoredItem, 0, len(brands))
		for _, b := range brands {
			out = append(out, &scoredItem{item: FoodItem{Brand: b}})
		}
		return out
	}
	tests := []struct {
		name  string
		query string
		items []*scoredItem
		want  bool
	}{
		{"single-token brand named outright", "coke zero", pool("Coke"), true},
		{"multi-token brand named in full", "smart soup indian bean", pool("SMART SOUP"), true},
		{"only a food word shared with a brand", "soup", pool("SMART SOUP"), false},
		{"only one word of a two-word brand", "hot chocolate", pool("HOT POCKETS"), false},
		{"no brand in the pool at all", "spinach", pool("", ""), false},
		{"brand present but unnamed", "chicken", pool("McDONALD'S"), false},
		{"empty query", "", pool("Coke"), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, queryNamesABrand(fieldSet(Normalize(tc.query)), tc.items))
		})
	}
}
