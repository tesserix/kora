package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// insertLog writes one food_logs row directly, so a test can control whether
// it resolved to a food item. itemID nil == an unresolved capture.
func insertLog(t *testing.T, db *gorm.DB, userID uuid.UUID, at time.Time, itemID *uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(`
		INSERT INTO food_logs (user_id, food_item_id, logged_at, local_date, meal_slot, source,
			description, quantity_grams, kcal, protein_g, carbs_g, fat_g, fiber_g, provenance)
		VALUES (?, ?, ?, ?, 'lunch', 'manual', 'first-log-after test', 100, 200, 10, 20, 5, 2, 'test')`,
		userID, itemID, at, at.Format("2006-01-02")).Error)
}

// TestFirstLogAfter covers the read fasting.Repository.Open depends on to
// answer "did the user eat after this fast began?" (kora#407). Getting any of
// these wrong changes when a fast is reported as having ended, and so what
// the eating-disorder guardrail measures.
func TestFirstLogAfter(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID) })

	// No logs at all.
	got, err := repo.FirstLogAfter(ctx, db, userID, base.Add(-24*time.Hour))
	require.NoError(t, err)
	require.Nil(t, got, "never logged means no log after anything")

	item := seedFoodItemFor(t, db)
	earlier := base.Add(-10 * time.Hour)
	later := base.Add(-4 * time.Hour)
	insertLog(t, db, userID, earlier, &item)
	insertLog(t, db, userID, later, &item)

	// The EARLIEST after the cutoff, not the latest: that is the meal that
	// ended the fast.
	got, err = repo.FirstLogAfter(ctx, db, userID, base.Add(-24*time.Hour))
	require.NoError(t, err)
	require.NotNil(t, got)
	require.WithinDuration(t, earlier, *got, time.Second)

	// Strictly after: a log AT the cutoff is not after it.
	got, err = repo.FirstLogAfter(ctx, db, userID, earlier)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.WithinDuration(t, later, *got, time.Second,
		"a log exactly at the fast's start cannot have ended it")

	// Nothing after the last log.
	got, err = repo.FirstLogAfter(ctx, db, userID, base)
	require.NoError(t, err)
	require.Nil(t, got)
}

// TestFirstLogAfterIgnoresUnresolvedCaptures: a queued photo that never
// resolved to a food item is not evidence the user ate, and must not end a
// fast. Same definition of "a log" ListForUserSince and DaysLoggedBetween use.
func TestFirstLogAfterIgnoresUnresolvedCaptures(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID) })

	insertLog(t, db, userID, base.Add(-3*time.Hour), nil)

	got, err := repo.FirstLogAfter(ctx, db, userID, base.Add(-12*time.Hour))
	require.NoError(t, err)
	require.Nil(t, got, "an unresolved capture is not a meal")
}
