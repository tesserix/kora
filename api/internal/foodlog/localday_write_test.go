package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// seedFoodItemFor inserts a known food and returns its id. The existing suite
// builds items inline (service_test.go); this wraps that so the local-day
// tests stay about dates.
func seedFoodItemFor(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "Local Day " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item.ID
}

// setUserTimezone sets the profile zone. seedUser inserts a bare row, so the
// column carries its SQL default until this runs.
func setUserTimezone(t *testing.T, db *gorm.DB, userID uuid.UUID, tz string) {
	t.Helper()
	require.NoError(t, db.Exec("UPDATE users SET timezone = ? WHERE id = ?", tz, userID).Error)
}

func sydneyLoc(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Australia/Sydney")
	require.NoError(t, err)
	return loc
}

// The client's date must survive to the database unchanged, even when the
// server's profile zone would have produced a different one. If this fails,
// the offline queue is filing replayed meals on the wrong day.
func TestLogFoodPersistsClientLocalDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		Source:        "manual",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), // 13:00 Sydney
		LocalDate:     "2026-02-28",                                // device was in Los Angeles
	}, sydneyLoc(t))
	require.NoError(t, err)
	require.Equal(t, "2026-02-28", log.LocalDate.Format("2006-01-02"),
		"the client's date must win over the profile zone")
}

func TestLogFoodFallsBackToProfileZoneWhenClientOmitsDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		Source:        "manual",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), // 13:00 Sydney
	}, sydneyLoc(t))
	require.NoError(t, err)
	require.Equal(t, "2026-03-01", log.LocalDate.Format("2006-01-02"))
}

func TestLogFoodRejectsOutOfWindowLocalDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		Source:        "manual",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		LocalDate:     "2026-03-09",
	}, sydneyLoc(t))
	require.Error(t, err)
}

// A batch write must validate and persist the date the same way, or the
// recipe-logging path becomes a hole in the guarantee.
func TestCreateBatchPersistsClientLocalDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	logs, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC),
		MealSlot: "dinner",
		// batchSources is {memory, meal, recipe} — "manual" is a LogFood
		// source, not a batch one. Omitted here so it defaults to "memory".
		LocalDate: "2026-02-28",
		Items:     []BatchItem{{FoodItemID: itemID, QuantityGrams: 100}},
	}, sydneyLoc(t))
	require.NoError(t, err)
	require.Len(t, logs, 1)
	require.Equal(t, "2026-02-28", logs[0].LocalDate.Format("2006-01-02"))
}

// dayOf gives a fixture the local day matching the instant it seeds.
//
// Mirrors the service's zero-time defaulting so a fixture passing time.Time{}
// still gets a plausible date; returning the zero date would write 0001-01-01
// and trip the local_date_plausible CHECK — the silent-corruption case that
// constraint exists to catch (kora#84).
func dayOf(t time.Time) time.Time {
	if t.IsZero() {
		t = time.Now()
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
