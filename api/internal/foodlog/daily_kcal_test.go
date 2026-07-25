package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestDailyKcalBucketsByLocalDay(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Kcal Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	d := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	// 100g of a 100kcal/100g item = 100 kcal each. Two on 04-10 (=>200), one on 04-09 (=>100).
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual", QuantityGrams: 100, LoggedAt: d})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(2 * time.Hour)})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(-24 * time.Hour)})

	from := time.Date(2026, 4, 8, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	m, err := NewRepository(db).DailyKcal(context.Background(), userID, from, to, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 200.0, m["2026-04-10"])
	require.Equal(t, 100.0, m["2026-04-09"])
}
