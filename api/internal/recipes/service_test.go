package recipes

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func ing(foodID string, grams float64, raw string) IngredientInput {
	return IngredientInput{FoodItemID: &foodID, Grams: grams, RawText: raw}
}

// TestPerServingMacrosDivideByServings is the core arithmetic: totals come
// from live food rows, per-serving divides by the yield.
func TestPerServingMacrosDivideByServings(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100) // 100 kcal/100g, 10 protein/100g
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "  Dal  ", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	require.Equal(t, "Dal", v.Name)           // trimmed
	require.Equal(t, 400.0, v.TotalKcal)      // 100/100 * 400
	require.Equal(t, 100.0, v.PerServingKcal) // 400 / 4
	require.Equal(t, 10.0, v.PerServingProteinG)
	require.Zero(t, v.UnresolvedCount)
}

// TestUnresolvedIngredientContributesZeroAndIsCounted proves an unresolved
// ingredient is neither dropped nor guessed at.
func TestUnresolvedIngredientContributesZeroAndIsCounted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Curry", Servings: 2, Source: SourcePaste,
		Ingredients: []IngredientInput{
			ing(f.ID.String(), 200, "200g lentils"),
			{FoodItemID: nil, RawText: "a pinch of asafoetida"},
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	require.Len(t, v.Ingredients, 2)
	require.Equal(t, 200.0, v.TotalKcal) // the unresolved line adds nothing
	require.Equal(t, 1, v.UnresolvedCount)
	require.False(t, v.Ingredients[1].Resolved)
	require.Equal(t, "a pinch of asafoetida", v.Ingredients[1].RawText)
}

// TestUpdateServingsRecomputesWithoutTouchingIngredients is #25's stated
// acceptance criterion.
func TestUpdateServingsRecomputesWithoutTouchingIngredients(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 100.0, created.PerServingKcal)

	id := uuid.MustParse(created.ID)
	updated, err := svc.Update(ctx, userID, id, SaveRecipeRequest{
		Name: "Dal", Servings: 8, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	require.Equal(t, 400.0, updated.TotalKcal)
	require.Equal(t, 50.0, updated.PerServingKcal) // 400 / 8
}

// TestPortionAssumedSurvivesSaveAndRead is issue #138's lesson applied: a
// guessed portion must stay labelled after the confirm screen is gone.
func TestPortionAssumedSurvivesSaveAndRead(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	fid := f.ID.String()
	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Guessy", Servings: 1, Source: SourcePhoto,
		Ingredients: []IngredientInput{{
			FoodItemID: &fid, Grams: 150, RawText: "some lentils", PortionAssumed: true,
		}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.True(t, created.Ingredients[0].PortionAssumed)

	read, err := svc.Get(ctx, userID, uuid.MustParse(created.ID))
	require.NoError(t, err)
	require.True(t, read.Ingredients[0].PortionAssumed, "assumed portion must survive the round trip")
}

// TestMatchingAnUnresolvedIngredientSaves walks the exact production path the
// "Find a match" affordance drives: a recipe is saved with an unresolved
// ingredient (which the server persists with grams 0 — it has no food to
// measure against), the user then picks a food for that line, and the client
// PUTs the whole list back with only food_item_id filled in. That save used to
// 400 with "grams must be positive" on every retry, making any recipe with one
// unmatchable ingredient permanently unsaveable.
func TestMatchingAnUnresolvedIngredientSaves(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100) // no serving_grams -> the flat 100g estimate
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Curry", Servings: 2, Source: SourcePaste,
		Ingredients: []IngredientInput{{FoodItemID: nil, RawText: "a pinch of asafoetida"}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 1, created.UnresolvedCount)
	require.Zero(t, created.Ingredients[0].Grams, "an unresolved ingredient carries no portion")

	// Exactly what both client match handlers send: the same list back with
	// food_item_id set and grams still zero.
	fid := f.ID.String()
	updated, err := svc.Update(ctx, userID, uuid.MustParse(created.ID), SaveRecipeRequest{
		Name: "Curry", Servings: 2, Source: SourcePaste,
		Ingredients: []IngredientInput{{FoodItemID: &fid, RawText: "a pinch of asafoetida", Grams: 0}},
	})
	require.NoError(t, err, "matching an unresolved ingredient must be saveable")
	require.Zero(t, updated.UnresolvedCount)
	require.Equal(t, defaultAssumedGrams, updated.Ingredients[0].Grams)
	require.True(t, updated.Ingredients[0].PortionAssumed,
		"a server-supplied portion is a guess and must never render as a measurement (#138)")

	read, err := svc.Get(ctx, userID, uuid.MustParse(created.ID))
	require.NoError(t, err)
	require.Equal(t, defaultAssumedGrams, read.Ingredients[0].Grams)
	require.True(t, read.Ingredients[0].PortionAssumed)
	require.Equal(t, 100.0, read.TotalKcal) // 100 kcal/100g * 100g
}

// TestMatchedIngredientDefaultsToTheFoodsOwnServing pins the preferred rung of
// that default: the food's real serving size, not the flat estimate.
func TestMatchedIngredientDefaultsToTheFoodsOwnServing(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	item := nutrition.FoodItem{
		Name: "RC Breast " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ServingGrams: 140,
	}
	item.NormalizedName = nutrition.Normalize(item.Name)
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	fid := item.ID.String()
	v, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Grill", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{{FoodItemID: &fid, RawText: "chicken", Grams: 0}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 140.0, v.Ingredients[0].Grams)
	require.True(t, v.Ingredients[0].PortionAssumed)
}

// TestCreateResolvesEnteredUnitsServerSide mirrors the saved-meal and
// food-log surfaces: the client never converts.
func TestCreateResolvesEnteredUnitsServerSide(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	sachet := nutrition.FoodItem{
		Name: "RC Sachet " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  100,
	}
	require.NoError(t, db.Create(&sachet).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", sachet.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	amount, unit := 2.0, "sachet"
	fid := sachet.ID.String()
	v, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Mocha", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{{
			FoodItemID: &fid, Grams: 0, RawText: "2 sachets",
			EnteredAmount: &amount, EnteredUnit: &unit,
		}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 33.0, v.Ingredients[0].Grams) // 2 * 16.5, resolved server-side
	require.Equal(t, 33.0, v.TotalKcal)            // 100/100 * 33
}

func TestCreateValidates(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	bad := func(req SaveRecipeRequest) {
		t.Helper()
		_, err := svc.Create(ctx, userID, req)
		_, ok := httpx.IsValidation(err)
		require.True(t, ok, "expected a validation error")
	}

	bad(SaveRecipeRequest{Name: "", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 0, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: "scanned",
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual})
	unknown := uuid.NewString()
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(unknown, 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{{FoodItemID: nil, RawText: ""}}})
}
