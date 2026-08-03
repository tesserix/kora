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

// TestLastPortionForPhraseReturnsMostRecent proves the most recent matching
// log's grams wins when the same phrase was logged more than once — the
// portion the alias short-circuit inherits must reflect what the user most
// recently ate, not the first time they used this phrase.
func TestLastPortionForPhraseReturnsMostRecent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Portion Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	ctx := context.Background()
	phrase := "brekkie eggs " + uuid.NewString()
	now := time.Now()

	older, err := repo.Create(ctx, FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-48 * time.Hour), MealSlot: "breakfast",
		Source: "ai_text", QuantityGrams: 80, Kcal: 80, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", older.ID) })

	newer, err := repo.Create(ctx, FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-1 * time.Hour), MealSlot: "breakfast",
		Source: "ai_text", QuantityGrams: 150, Kcal: 150, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", newer.ID) })

	grams, found, err := repo.LastPortionForPhrase(ctx, userID, phrase)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, 150.0, grams, "the most recently logged portion for this phrase must win")
}

// TestLastPortionForPhraseIgnoresOtherUsers proves the lookup is per-user:
// another user's log of the identical phrase must never leak in.
func TestLastPortionForPhraseIgnoresOtherUsers(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	other := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Portion Food Other " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	ctx := context.Background()
	phrase := "brekkie eggs " + uuid.NewString()

	otherLog, err := repo.Create(ctx, FoodLog{
		UserID: other, FoodItemID: &item.ID, LoggedAt: time.Now(), MealSlot: "breakfast",
		Source: "ai_text", QuantityGrams: 300, Kcal: 300, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", otherLog.ID) })

	_, found, err := repo.LastPortionForPhrase(ctx, userID, phrase)
	require.NoError(t, err)
	require.False(t, found, "another user's log of the same phrase must not be found")
}

// TestLastPortionForPhraseIgnoresNullInputPhrase proves logs with no
// input_phrase (manual/barcode/photo logs) never match a phrase lookup.
func TestLastPortionForPhraseIgnoresNullInputPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Portion Food Null " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	ctx := context.Background()
	phrase := "brekkie eggs " + uuid.NewString()

	manual, err := repo.Create(ctx, FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: time.Now(), MealSlot: "breakfast",
		Source: "manual", QuantityGrams: 300, Kcal: 300, InputPhrase: nil,
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", manual.ID) })

	_, found, err := repo.LastPortionForPhrase(ctx, userID, phrase)
	require.NoError(t, err)
	require.False(t, found, "a log with a NULL input_phrase must never match a phrase lookup")
}

// TestLastPortionForPhraseNotFound proves the not-found case is a plain
// false, not an error.
func TestLastPortionForPhraseNotFound(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, found, err := repo.LastPortionForPhrase(context.Background(), userID, "never logged "+uuid.NewString())
	require.NoError(t, err)
	require.False(t, found)
}

func TestHasLoggedBefore(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "HasLoggedBefore Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	ctx := context.Background()
	now := time.Now()

	got, err := repo.HasLoggedBefore(ctx, userID, now)
	require.NoError(t, err)
	require.False(t, got, "a user with no logs at all has not logged before anything")

	old, err := repo.Create(ctx, FoodLog{UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-10 * 24 * time.Hour), MealSlot: "breakfast", QuantityGrams: 60, Kcal: 100})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", old.ID) })

	got, err = repo.HasLoggedBefore(ctx, userID, now)
	require.NoError(t, err, "a log strictly before `before` must be found")
	require.True(t, got)

	got, err = repo.HasLoggedBefore(ctx, userID, old.LoggedAt.Add(-time.Hour))
	require.NoError(t, err)
	require.False(t, got, "nothing was logged before an hour prior to the only seeded log")
}

// TestCreateIdempotentReplayReturnsExistingRow is the core safety property of
// the offline queue: a write whose response was lost must be replayable
// without creating a second meal. Duplication is worse than loss — a missing
// log is visible, a duplicated one silently inflates the day.
func TestCreateIdempotentReplayReturnsExistingRow(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	id := uuid.New()
	log := FoodLog{ID: id, UserID: userID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: "Test food", QuantityGrams: 100, Kcal: 200}

	first, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	require.Equal(t, id, first.ID)

	// Replay the identical write — as a queue drain would after a lost response.
	second, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	require.Equal(t, id, second.ID)

	var count int64
	require.NoError(t, tx.Model(&FoodLog{}).Where("id = ?", id).Count(&count).Error)
	require.Equal(t, int64(1), count, "replay must not create a second row")
}

// TestCreateIdempotentRejectsAnotherUsersID stops a client probing for, or
// colliding with, an id that belongs to somebody else. The error must not
// confirm that the id exists.
func TestCreateIdempotentRejectsAnotherUsersID(t *testing.T) {
	db := testDB(t)
	ownerID := seedUser(t, db)
	intruderID := seedUser(t, db)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	id := uuid.New()
	owner := FoodLog{ID: id, UserID: ownerID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: "Owner food", QuantityGrams: 100, Kcal: 200}
	_, err := repo.CreateIdempotent(context.Background(), owner)
	require.NoError(t, err)

	intruder := owner
	intruder.UserID = intruderID
	intruder.Description = "Intruder food"
	_, err = repo.CreateIdempotent(context.Background(), intruder)
	require.Error(t, err)
	require.NotContains(t, err.Error(), id.String(), "must not disclose the id")

	var got FoodLog
	require.NoError(t, tx.First(&got, "id = ?", id).Error)
	require.Equal(t, "Owner food", got.Description, "the owner's row must be untouched")
}
