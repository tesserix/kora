package tracking

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The retry path is the normal path: a failed sync leaves the device anchor
// unmoved, so the next launch re-sends the same window.
func TestAddWeightEntryWithHKUUIDIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	hk := uuid.New()

	in := WeightInput{
		WeightKg:    70.4,
		LoggedAt:    time.Now(),
		LocalDate:   time.Now(),
		HKUUID:      &hk,
		Composition: BodyComposition{Source: SourceHealthKit},
	}

	first, err := repo.AddWeightEntry(context.Background(), userID, in)
	require.NoError(t, err)
	second, err := repo.AddWeightEntry(context.Background(), userID, in)
	require.NoError(t, err, "a re-sync must not error")
	require.Equal(t, first.ID, second.ID, "a re-sync must return the stored row, not a new one")

	var count int64
	require.NoError(t, db.Model(&WeightEntry{}).Where("user_id = ?", userID).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

// A HealthKit weight and a hand-typed one on the same day are two real
// readings from two instruments (migration 000039). Dedup must not reach
// across sources.
func TestHealthKitWeightDoesNotDedupeAgainstManual(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	hk := uuid.New()
	now := time.Now()

	_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg: 70.4, LoggedAt: now, LocalDate: now,
		HKUUID: &hk, Composition: BodyComposition{Source: SourceHealthKit},
	})
	require.NoError(t, err)

	_, err = repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg: 70.9, LoggedAt: now, LocalDate: now,
		Composition: BodyComposition{Source: SourceManual},
	})
	require.NoError(t, err)

	var count int64
	require.NoError(t, db.Model(&WeightEntry{}).Where("user_id = ?", userID).Count(&count).Error)
	require.EqualValues(t, 2, count, "both readings must survive")
}
