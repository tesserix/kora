package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// The motivating regression for kora#84: a log's day must not move when the
// user's profile timezone changes. Before this work the day boundary was
// recomputed at read time from whatever the profile said NOW, so flying
// Sydney -> Los Angeles retroactively moved yesterday's dinner to another day.
func TestListByDayDoesNotMoveWhenProfileTimezoneChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	// 02:00Z is 13:00 on the 1st in Sydney but 18:00 on the PREVIOUS day in
	// Los Angeles — the instant where the two zones disagree, which is what
	// makes this test able to fail.
	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "dinner",
		Source:        "manual",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC),
		LocalDate:     "2026-03-01",
	}, sydneyLoc(t))
	require.NoError(t, err)

	day := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

	before, err := repo.ListByUserAndDay(context.Background(), userID, day)
	require.NoError(t, err)
	require.Len(t, before, 1)

	setUserTimezone(t, db, userID, "America/Los_Angeles")

	after, err := repo.ListByUserAndDay(context.Background(), userID, day)
	require.NoError(t, err)
	require.Len(t, after, 1, "changing the profile timezone must not re-bucket history")
}

// The read must honour the STORED date, not re-derive one. A row whose
// local_date deliberately disagrees with its logged_at (an offline capture
// replayed from another zone) must come back on the day it was captured.
func TestListByDayHonoursTheStoredDateNotTheTimestamp(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "dinner",
		Source:        "manual",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC),
		LocalDate:     "2026-02-28", // captured in Los Angeles
	}, sydneyLoc(t))
	require.NoError(t, err)

	onCaptureDay, err := repo.ListByUserAndDay(context.Background(), userID, time.Date(2026, 2, 28, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, onCaptureDay, 1, "the log belongs to the day it was captured")

	onSydneyDay, err := repo.ListByUserAndDay(context.Background(), userID, time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Empty(t, onSydneyDay, "it must NOT also appear on the profile-zone day")
}

// CopyDay and RepeatLog CLONE an existing log and move its timestamp. Both
// must move the stored day too — a clone that keeps the source's local_date
// lands on the source's day and is invisible on the day the user asked for.
// Neither was in the original plan; both are regressions the column
// introduces if the clone paths are not updated.
func TestCopyDayFilesClonesOnTheTargetDay(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	from := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &itemID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100,
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), LocalDate: "2026-03-01",
	}, sydneyLoc(t))
	require.NoError(t, err)

	n, err := svc.CopyDay(context.Background(), userID, from, to)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	onTarget, err := repo.ListByUserAndDay(context.Background(), userID, to)
	require.NoError(t, err)
	require.Len(t, onTarget, 1, "the copy must appear on the day it was copied to")
}

func TestRepeatLogFilesTheCloneOnTheRequestedDay(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	src, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &itemID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100,
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), LocalDate: "2026-03-01",
	}, sydneyLoc(t))
	require.NoError(t, err)

	at := time.Date(2026, 3, 5, 2, 0, 0, 0, time.UTC)
	repeated, err := svc.RepeatLog(context.Background(), userID, src.ID, at,
		time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Equal(t, "2026-03-05", repeated.LocalDate.Format("2006-01-02"),
		"a repeated log belongs to the day it was repeated onto, not the original's day")

	onTarget, err := repo.ListByUserAndDay(context.Background(), userID, time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, onTarget, 1)
}
