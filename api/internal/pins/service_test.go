package pins

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestCreateEnrichesMacrosFromGrams(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db) // 100 kcal/100g, 10g protein/100g
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })

	pf, err := svc.Create(context.Background(), userID, CreatePinRequest{FoodItemID: food.ID.String(), Grams: 200, MealSlot: "breakfast"})
	require.NoError(t, err)
	require.Equal(t, food.ID.String(), pf.FoodItemID)
	require.Equal(t, 200.0, pf.Kcal)    // 100/100 * 200
	require.Equal(t, 20.0, pf.ProteinG) // 10/100 * 200
	require.Equal(t, "breakfast", pf.MealSlot)

	list, err := svc.List(context.Background(), userID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, food.Name, list[0].Name)
}

func TestCreateValidates(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	_, err := svc.Create(context.Background(), userID, CreatePinRequest{FoodItemID: food.ID.String(), Grams: 0, MealSlot: "lunch"})
	_, isVal := httpx.IsValidation(err)
	require.True(t, isVal, "grams<=0 should be a validation error")

	_, err = svc.Create(context.Background(), userID, CreatePinRequest{FoodItemID: food.ID.String(), Grams: 100, MealSlot: "brunch"})
	_, isVal = httpx.IsValidation(err)
	require.True(t, isVal, "bad meal_slot should be a validation error")

	_, err = svc.Create(context.Background(), userID, CreatePinRequest{FoodItemID: uuid.NewString(), Grams: 100, MealSlot: "lunch"})
	_, isVal = httpx.IsValidation(err)
	require.True(t, isVal, "unknown food_item_id should be a validation error")
}

// TestCreateEnforcesCapButAllowsRepin drives a user to exactly maxPins pins
// (seeding maxPins distinct foods, since the pins table is UNIQUE(user_id,
// food_item_id) and can't hold duplicate foods), then asserts: a new food
// is rejected once at the cap, but re-pinning a food the user already has
// pinned still succeeds and updates it in place.
func TestCreateEnforcesCapButAllowsRepin(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })

	pinnedFoods := make([]nutrition.FoodItem, maxPins)
	for i := 0; i < maxPins; i++ {
		food := seedFood(t, db)
		_, err := repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: food.ID, Grams: 100, MealSlot: "lunch"})
		require.NoError(t, err)
		pinnedFoods[i] = food
	}
	count, err := repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(maxPins), count)

	newFood := seedFood(t, db)
	_, err = svc.Create(ctx, userID, CreatePinRequest{FoodItemID: newFood.ID.String(), Grams: 100, MealSlot: "lunch"})
	_, isVal := httpx.IsValidation(err)
	require.True(t, isVal, "pinning a new food at the cap should be a validation error")

	alreadyPinned := pinnedFoods[0]
	pf, err := svc.Create(ctx, userID, CreatePinRequest{FoodItemID: alreadyPinned.ID.String(), Grams: 200, MealSlot: "dinner"})
	require.NoError(t, err, "re-pinning an already-pinned food at the cap should succeed")
	require.Equal(t, alreadyPinned.ID.String(), pf.FoodItemID)
	require.Equal(t, 200.0, pf.Grams)
	require.Equal(t, "dinner", pf.MealSlot)

	count, err = repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(maxPins), count, "re-pin must update in place, not add a new row")
}

// TestListReturnsEnrichedPinsForAllFoods covers List's enrichment path for
// pins whose foods still exist.
//
// NOTE: List's skip-on-gorm.ErrRecordNotFound branch (a pin surviving its
// food's deletion) is defensive and unreachable in this schema: the
// food_items -> pins FK is ON DELETE CASCADE (see
// internal/database/migrations/000016_pins.up.sql), so deleting a food row
// deletes its pin(s) too — a genuine orphan pin cannot be produced without
// violating that FK. We don't fabricate one via raw SQL; instead this test
// locks down the reachable path: List enriches every pin whose food exists.
func TestListReturnsEnrichedPinsForAllFoods(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	foodA := seedFood(t, db)
	foodB := seedFood(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })

	_, err := repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: foodA.ID, Grams: 100, MealSlot: "breakfast"})
	require.NoError(t, err)
	_, err = repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: foodB.ID, Grams: 50, MealSlot: "snack"})
	require.NoError(t, err)

	list, err := svc.List(ctx, userID)
	require.NoError(t, err)
	require.Len(t, list, 2)

	byID := make(map[string]PinnedFood, len(list))
	for _, pf := range list {
		byID[pf.FoodItemID] = pf
	}

	pfA, ok := byID[foodA.ID.String()]
	require.True(t, ok, "pin for foodA should be present")
	require.Equal(t, foodA.Name, pfA.Name)
	require.Equal(t, "breakfast", pfA.MealSlot)
	require.Equal(t, 100.0, pfA.Kcal) // 100 kcal/100g * 100g

	pfB, ok := byID[foodB.ID.String()]
	require.True(t, ok, "pin for foodB should be present")
	require.Equal(t, foodB.Name, pfB.Name)
	require.Equal(t, "snack", pfB.MealSlot)
	require.Equal(t, 50.0, pfB.Kcal) // 100 kcal/100g * 50g
}
