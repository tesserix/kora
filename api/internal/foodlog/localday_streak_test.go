package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// kora#84 fixed the diary's day bucketing but left the streak and trends
// queries deriving their day from `logged_at AT TIME ZONE profile_tz`. That is
// worse than the original bug: the two surfaces now DISAGREE, and the user can
// see both — a meal visible on Tuesday in the diary while the streak counts
// Tuesday as missed.
//
// These pin that the day-bucketed queries agree with the diary by construction.
func TestLoggedDaysDescAgreesWithTheDiary(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	// Captured in Los Angeles on the 28th; 02:00Z is the 1st in Sydney. The
	// old derivation would file this on 2026-03-01, the diary on 2026-02-28.
	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &itemID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100,
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), LocalDate: "2026-02-28",
	}, sydneyLoc(t))
	require.NoError(t, err)

	diary, err := repo.ListByUserAndDay(context.Background(), userID,
		time.Date(2026, 2, 28, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, diary, 1, "precondition: the diary files this on the 28th")

	days, err := repo.LoggedDaysDesc(context.Background(), userID,
		time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), 4000)
	require.NoError(t, err)
	require.Contains(t, days, "2026-02-28",
		"the streak must count the day the diary shows, not one re-derived from the profile zone")
	require.NotContains(t, days, "2026-03-01",
		"and must NOT also count the profile-zone day")
}

func TestDailyKcalAgreesWithTheDiary(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &itemID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100,
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), LocalDate: "2026-02-28",
	}, sydneyLoc(t))
	require.NoError(t, err)

	byDay, err := repo.DailyKcal(context.Background(), userID,
		time.Date(2026, 2, 20, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Contains(t, byDay, "2026-02-28", "trends must bucket on the stored day")
	require.NotContains(t, byDay, "2026-03-01")
}

// The property that motivated kora#84 in the first place, now asserted for the
// streak query too: changing the profile timezone must not move history.
func TestLoggedDaysDescDoesNotMoveWhenProfileTimezoneChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &itemID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100,
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), LocalDate: "2026-03-01",
	}, sydneyLoc(t))
	require.NoError(t, err)

	notAfter := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	before, err := repo.LoggedDaysDesc(context.Background(), userID, notAfter, 4000)
	require.NoError(t, err)
	require.Contains(t, before, "2026-03-01")

	setUserTimezone(t, db, userID, "Pacific/Kiritimati")

	after, err := repo.LoggedDaysDesc(context.Background(), userID, notAfter, 4000)
	require.NoError(t, err)
	require.Equal(t, before, after, "a timezone change must not re-bucket streak history")
}
