package nutrition

import (
	"testing"

	"github.com/google/uuid"
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

func TestBrandUnqualified(t *testing.T) {
	tests := []struct {
		name               string
		query, food, brand string
		want               bool
	}{
		{"generic row has no brand", "oat", "Rolled oats, raw", "", false},
		{"blank-ish brand normalizes to nothing", "oat", "Rolled oats, raw", "  -- ", false},
		{"bare word against a branded product", "oat", "Oat", "Sanitarium So Good", true},
		{"bare word against an accented brand", "rye", "Rye", "Bürgen", true},
		{"query names the maker", "sanitarium oat", "Oat", "Sanitarium So Good", false},
		{"query names one distinguishing token of a messy brand",
			"youfoodz butter chicken", "Butter Chicken", "Youfoodz Fuel'd", false},
		{"query names the maker after singularizing", "chip co", "Corn Chips", "Chips Co", false},
		{"brand present but query names none of its tokens", "chicken", "Chicken", "YoufoodZ", true},

		// Brand wholly contained in the name: the product is named after its
		// maker, so naming the product names the maker.
		{"brand equals the name", "weet bix", "Weet-Bix", "Weet-Bix", false},
		{"brand is a prefix of the name", "coke zero", "Coke Zero Sugar", "Coke", false},

		// The measured regression this rule exists to prevent: "milk" is a
		// word the FOOD supplies, not the maker, so it names no brand.
		{"food word shared with the brand string is not a brand signal",
			"milk", "Milk", "a2 Milk Company", true},
		{"same trap inside an OFF junk brand string",
			"corn chip", "Corn Chips", "Sonora Corn Chips  Salted 500g", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := brandUnqualified(Normalize(tt.query), Normalize(tt.food), tt.brand)
			require.Equal(t, tt.want, got)
		})
	}
}

func TestUnqualifiedBrandedProductLosesToTheGenericFood(t *testing.T) {
	// The measured prod defect, as scores. Bare query "oat":
	//   "Oat" (Sanitarium So Good — oat milk, 46 kcal) matched every signal.
	//   "Rolled oats, raw" (AFCD, 379 kcal) is what the user meant.
	oatMilk := quality(components{Coverage: 1, Precision: 1, Trigram: 1, UnqualifiedBrand: true})
	rolledOats := quality(components{Coverage: 1, Precision: 1.0 / 3.0, Trigram: 0.286})

	require.Greater(t, rolledOats, oatMilk,
		"an unqualified query must prefer the generic food over a product named after it")

	// headBonus applies to both here (both head nouns are "oat"), so it
	// cancels and cannot rescue the ranking — the base quality has to carry it.
	require.Greater(t, rolledOats+headBonus, oatMilk+headBonus)

	// And it must not merely lose the ranking: it must stop claiming a
	// confidence it has not earned.
	require.Less(t, oatMilk, tierConfirmFloorForTest,
		"a branded row the user never named must never be auto-logged or one-tap confirmed")
}

// tierConfirmFloorForTest mirrors ai.tierConfirmFloor (0.70), which nutrition
// cannot import without a cycle. If that floor ever moves, this constant is
// the thing to update.
const tierConfirmFloorForTest = 0.70

func TestNamingTheBrandExemptsTheRow(t *testing.T) {
	// "Coke Zero" -> "Coke Zero Sugar" (brand "Coke") must not move: the query
	// names the maker, so the discount must not apply. This candidate is the
	// ONLY one the query returns in prod — there is no fallback behind it.
	c := components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.625,
		UnqualifiedBrand: brandUnqualified(Normalize("Coke Zero"), Normalize("Coke Zero Sugar"), "Coke")}
	require.False(t, c.UnqualifiedBrand)
	require.InDelta(t, 0.7875, quality(c), 0.0001)
	require.GreaterOrEqual(t, quality(c), tierConfirmFloorForTest)
}

func TestBrandDiscountLeavesGenericRowsUntouched(t *testing.T) {
	// "banana" -> AFCD "Banana" (no brand) must keep its perfect score.
	c := components{Coverage: 1, Precision: 1, Trigram: 1}
	require.InDelta(t, 1.0, quality(c), 0.0001)

	// The discount is a common factor, so it cannot flip which path won.
	embWins := components{Coverage: 0, Precision: 0, Trigram: 0.1, EmbSim: 0.9}
	embWins.UnqualifiedBrand = true
	require.InDelta(t, embeddingFactor*0.9*unqualifiedBrandFactor, quality(embWins), 0.0001)
}

func TestBrandDiscountNeedsAGenericToDemoteTo(t *testing.T) {
	// genericAlternative is condition 3 of the discount: it is what keeps
	// "Weet-Bix" (a product with no generic behind it) at full score while
	// "oat" (a food whose generic rows were losing) gets its ranking fixed.
	build := func(items ...*scoredItem) (map[uuid.UUID]*scoredItem, []uuid.UUID) {
		pool := map[uuid.UUID]*scoredItem{}
		var order []uuid.UUID
		for _, s := range items {
			id := uuid.New()
			s.item.ID = id
			pool[id] = s
			order = append(order, id)
		}
		return pool, order
	}
	row := func(brand string, coverage float64) *scoredItem {
		return &scoredItem{item: FoodItem{Brand: brand}, comp: components{Coverage: coverage}}
	}

	tests := []struct {
		name  string
		items []*scoredItem
		want  bool
	}{
		{"no candidates at all", nil, false},
		{"only branded products — 'weet bix'", []*scoredItem{row("Sanitarium", 1), row("Aldi", 1)}, false},
		{"a generic food answers too — 'oat'", []*scoredItem{row("Sanitarium So Good", 1), row("", 1)}, true},
		{"blank-but-whitespace brand still counts as generic", []*scoredItem{row("  ", 1)}, true},
		{"a semantically-near unbranded row does not count", []*scoredItem{row("Coke", 1), row("", 0.5)}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pool, order := build(tt.items...)
			require.Equal(t, tt.want, genericAlternative(pool, order))
		})
	}
}
