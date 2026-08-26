package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)


// TestStatedCookingMethodDoesNotRewardRawRows pins kora#467.
//
// AUSNUT names the CUT, not the preparation: "Lamb, roast, lean, raw" is a
// roasting joint sold raw. cookingMethodBonus was awarded on a substring test
// against the row name, so that row collected the "roast" bonus while being
// raw — and so did every raw sibling, which put the entire top 5 for "roast
// lamb" on raw rows at roughly half the calories of the cooked answer.
//
// The bonus is WITHHELD from a raw row rather than subtracted from it, because
// every signal in this ranker only ever adds; see the cookingMethodBonus doc.
func TestStatedCookingMethodDoesNotRewardRawRows(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	raw := FoodItem{
		ID: uuid.New(), Name: "Lamb, roast, lean, raw",
		NormalizedName: Normalize("Lamb, roast, lean, raw"),
		Provenance:     "ausnut", KcalPer100g: 116.9, EntityType: EntityTypeGeneric,
	}
	cooked := FoodItem{
		ID: uuid.New(), Name: "Lamb, roast, lean, baked or roasted, added fat",
		NormalizedName: Normalize("Lamb, roast, lean, baked or roasted, added fat"),
		Provenance:     "ausnut", KcalPer100g: 161.1, EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&raw).Error)
	require.NoError(t, tx.Create(&cooked).Error)

	got, err := repo.ResolveQuery(ctx, uuid.Nil,
		Query{Text: "lamb", CookingMethod: "roast"}, nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, got, "expected candidates for a lamb query")

	// Guard the premise: the raw row really does contain the method token, which
	// is the whole reason it was collecting the bonus.
	require.Contains(t, raw.NormalizedName, "roast")

	require.Equal(t, cooked.ID, got[0].Item.ID,
		"a stated cooking method must not rank a RAW row above the cooked one; got %q", got[0].Item.Name)
}

// TestCookingMethodRawStillMatchesRawRows guards the other direction: identify
// does emit cooking_method "raw" (the vegemite case in ranking.sample.jsonl),
// and for those queries a raw row is the CORRECT answer and must still earn the
// bonus. A fix that blanket-demotes raw would break this.
func TestCookingMethodRawStillMatchesRawRows(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	raw := FoodItem{
		ID: uuid.New(), Name: "Carrot, raw",
		NormalizedName: Normalize("Carrot, raw"),
		Provenance:     "ausnut", KcalPer100g: 41, EntityType: EntityTypeGeneric,
	}
	boiled := FoodItem{
		ID: uuid.New(), Name: "Carrot, boiled, drained",
		NormalizedName: Normalize("Carrot, boiled, drained"),
		Provenance:     "ausnut", KcalPer100g: 35, EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&raw).Error)
	require.NoError(t, tx.Create(&boiled).Error)

	got, err := repo.ResolveQuery(ctx, uuid.Nil,
		Query{Text: "carrot", CookingMethod: "raw"}, nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, raw.ID, got[0].Item.ID,
		"cooking_method \"raw\" must still prefer the raw row; got %q", got[0].Item.Name)
}
