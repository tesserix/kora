package savedmeals

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func itemReq(id string, grams float64) struct {
	FoodItemID string  `json:"food_item_id"`
	Grams      float64 `json:"grams"`
} {
	return struct {
		FoodItemID string  `json:"food_item_id"`
		Grams      float64 `json:"grams"`
	}{FoodItemID: id, Grams: grams}
}

func TestCreateEnrichesAndTotals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100) // 100 kcal/100g, 10 protein/100g
	f2 := seedFood(t, db, 200)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	req := SaveMealRequest{Name: " My Bfast ", MealSlot: "breakfast"}
	req.Items = append(req.Items, itemReq(f1.ID.String(), 200), itemReq(f2.ID.String(), 100))
	v, err := svc.Create(context.Background(), userID, req)
	require.NoError(t, err)
	require.Equal(t, "My Bfast", v.Name) // trimmed
	require.Len(t, v.Items, 2)
	require.Equal(t, 200.0, v.Items[0].Kcal) // 100/100*200
	require.Equal(t, 400.0, v.Kcal)          // 200 + 200/100*100
}

func TestCreateValidates(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	bad := func(req SaveMealRequest) {
		_, err := svc.Create(context.Background(), userID, req)
		_, ok := httpx.IsValidation(err)
		require.True(t, ok)
	}
	r := SaveMealRequest{Name: "", MealSlot: "breakfast"}
	r.Items = append(r.Items, itemReq(f1.ID.String(), 100))
	bad(r) // empty name
	r = SaveMealRequest{Name: "x", MealSlot: "brunch"}
	r.Items = append(r.Items, itemReq(f1.ID.String(), 100))
	bad(r) // bad slot
	bad(SaveMealRequest{Name: "x", MealSlot: "lunch"}) // no items
	r = SaveMealRequest{Name: "x", MealSlot: "lunch"}
	r.Items = append(r.Items, itemReq(uuid.NewString(), 100))
	bad(r) // unknown food
}
