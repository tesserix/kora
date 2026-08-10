package savedmeals

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func itemReq(id string, grams float64) struct {
	FoodItemID    string   `json:"food_item_id"`
	Grams         float64  `json:"grams"`
	EnteredAmount *float64 `json:"entered_amount"`
	EnteredUnit   *string  `json:"entered_unit"`
} {
	return struct {
		FoodItemID    string   `json:"food_item_id"`
		Grams         float64  `json:"grams"`
		EnteredAmount *float64 `json:"entered_amount"`
		EnteredUnit   *string  `json:"entered_unit"`
	}{FoodItemID: id, Grams: grams}
}

// itemReqUnit builds an item entered by (amount, unit) rather than raw grams
// — mirrors itemReq but for the entered-unit path.
func itemReqUnit(id string, amount float64, unit string) struct {
	FoodItemID    string   `json:"food_item_id"`
	Grams         float64  `json:"grams"`
	EnteredAmount *float64 `json:"entered_amount"`
	EnteredUnit   *string  `json:"entered_unit"`
} {
	return struct {
		FoodItemID    string   `json:"food_item_id"`
		Grams         float64  `json:"grams"`
		EnteredAmount *float64 `json:"entered_amount"`
		EnteredUnit   *string  `json:"entered_unit"`
	}{FoodItemID: id, EnteredAmount: &amount, EnteredUnit: &unit}
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

// TestCreateResolvesEnteredUnits proves the server, not the client, resolves
// an entered unit into grams for saved-meal items — mirroring
// foodlog.TestLogFoodResolvesEnteredUnitToGrams for the saved-meal surface.
func TestCreateResolvesEnteredUnits(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	// One sachet is 16.5g, base unit grams.
	sachet := nutrition.FoodItem{
		Name: "SM Sachet Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}
	require.NoError(t, db.Create(&sachet).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", sachet.ID) })

	milk := seedFood(t, db, 60)

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	req := SaveMealRequest{Name: "Morning mocha", MealSlot: "breakfast"}
	req.Items = append(req.Items, itemReqUnit(sachet.ID.String(), 1.0, "sachet"), itemReq(milk.ID.String(), 200))

	got, err := svc.Create(context.Background(), userID, req)
	require.NoError(t, err)
	require.Len(t, got.Items, 2)

	// The sachet resolved server-side; the gram-entered milk is untouched.
	assert.InDelta(t, 16.5, got.Items[0].Grams, 1e-9)
	require.NotNil(t, got.Items[0].EnteredUnit)
	assert.Equal(t, "sachet", *got.Items[0].EnteredUnit)

	assert.InDelta(t, 200.0, got.Items[1].Grams, 1e-9)
	assert.Nil(t, got.Items[1].EnteredUnit)
}

// TestCreateRejectsUnknownUnit proves units.ErrNoConversion surfaces as a
// client validation error — never a substituted default — reusing the exact
// message foodlog.LogFood returns for the same failure.
func TestCreateRejectsUnknownUnit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	item := nutrition.FoodItem{
		Name: "SM No Servings Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit: "g", ServingUnits: json.RawMessage(`[]`), KcalPer100g: 100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	req := SaveMealRequest{Name: "x", MealSlot: "snack"}
	req.Items = append(req.Items, itemReqUnit(item.ID.String(), 1.0, "handful"))

	_, err := svc.Create(context.Background(), userID, req)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok)
	assert.Equal(t, "unrecognised unit for this food", msg)
}
