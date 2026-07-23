package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoggedDaysDescReturnsDistinctDays(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Days Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	// Two logs same day + one the day before.
	d := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual", QuantityGrams: 100, LoggedAt: d})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(6 * time.Hour)})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(-24 * time.Hour)})

	days, err := NewRepository(db).LoggedDaysDesc(context.Background(), userID, d, time.UTC, 400)
	require.NoError(t, err)
	require.Equal(t, []string{"2026-04-10", "2026-04-09"}, days)
}
