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
