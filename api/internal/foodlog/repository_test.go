package foodlog

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestUpdatePersistsFieldsForOwner(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Update Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	created, err := repo.Create(context.Background(), FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: item.Name, QuantityGrams: 100, Kcal: 100, ProteinG: 10,
		Provenance: item.Provenance,
	})
	require.NoError(t, err)

	created.QuantityGrams = 200
	created.Kcal = 200
	created.ProteinG = 20
	created.MealSlot = "dinner"
	updated, err := repo.Update(context.Background(), created)
	require.NoError(t, err)
	require.Equal(t, 200.0, updated.QuantityGrams)
	require.Equal(t, 200.0, updated.Kcal)
	require.Equal(t, "dinner", updated.MealSlot)
}

func TestUpdateIsNotFoundForOtherUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	otherUserID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Update Food Other " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	created, err := repo.Create(context.Background(), FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: item.Name, QuantityGrams: 100, Kcal: 100,
		Provenance: item.Provenance,
	})
	require.NoError(t, err)

	// Attempt to update the log as if it belonged to a different user.
	attempt := created
	attempt.UserID = otherUserID
	attempt.QuantityGrams = 999
	_, err = repo.Update(context.Background(), attempt)
	require.Error(t, err)
	require.True(t, errors.Is(err, gorm.ErrRecordNotFound))
}

func TestListForUserSince(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Since Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	ctx := context.Background()

	now := time.Now()
	// in-window
	inWindow, err := repo.Create(ctx, FoodLog{UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-2 * 24 * time.Hour), MealSlot: "breakfast", QuantityGrams: 60, Kcal: 100})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", inWindow.ID) })
	// out-of-window
	outOfWindow, err := repo.Create(ctx, FoodLog{UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-200 * 24 * time.Hour), MealSlot: "breakfast", QuantityGrams: 60, Kcal: 100})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", outOfWindow.ID) })

	got, err := repo.ListForUserSince(ctx, userID, now.Add(-90*24*time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, inWindow.ID, got[0].ID)
}
