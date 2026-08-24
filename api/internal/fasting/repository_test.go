package fasting

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedUser inserts a bare user row and returns its id.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "fa-"+id.String(), "fa@test.dev").Error)
	t.Cleanup(func() {
		// Scoped to this test's own user, never a truncate -- these tests own
		// their fixtures and must not disturb anyone else's rows (kora#151).
		db.Exec("DELETE FROM fasting_intervals WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestStartIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	first, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	// A double-tap, or a client retry, must not 400 and must not open a second.
	second, err := repo.Start(context.Background(), userID, now.Add(time.Minute), now)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID, "starting twice returns the SAME open fast")
}

func TestASecondOpenFastIsRejectedButASecondClosedFastIsFine(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	_, err := repo.Start(context.Background(), userID, now.Add(-4*time.Hour), now)
	require.NoError(t, err)
	_, ended, err := repo.End(context.Background(), userID, now.Add(-time.Hour))
	require.NoError(t, err)
	require.True(t, ended)

	// The index is PARTIAL: once the first is closed, a second may open.
	// A non-partial unique index on (user_id) would reject this.
	_, err = repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err, "a user must be able to fast more than once")
}

func TestEndReportsWhenThereWasNothingOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, ended, err := repo.End(context.Background(), userID, time.Now())
	require.NoError(t, err, "ending nothing is not an error, just a no-op")
	require.False(t, ended)
}

// TestEndSetsEndedAtAndEndedByTogether guards the finding carried from Task
// 1's review: the table's CHECK constraints validate ended_at > started_at
// and ended_by = 'user' independently, but not as a pair. Repository.End is
// the only write path for either, so it must never leave one set without
// the other.
func TestEndSetsEndedAtAndEndedByTogether(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	_, err := repo.Start(context.Background(), userID, now.Add(-time.Hour), now)
	require.NoError(t, err)

	ended, ok, err := repo.End(context.Background(), userID, now)
	require.NoError(t, err)
	require.True(t, ok)
	require.NotNil(t, ended.EndedAt)
	require.NotNil(t, ended.EndedBy)
	require.Equal(t, EndedByUser, *ended.EndedBy)

	var stored Interval
	require.NoError(t, db.Where("id = ?", ended.ID).First(&stored).Error)
	require.NotNil(t, stored.EndedAt)
	require.NotNil(t, stored.EndedBy)
	require.Equal(t, EndedByUser, *stored.EndedBy)
}

func TestSinceReturnsOpenAndRecentlyClosedIntervals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	// Closed well before the window: excluded.
	old, err := repo.Start(context.Background(), userID, now.Add(-72*time.Hour), now)
	require.NoError(t, err)
	require.NoError(t, db.Model(&Interval{}).Where("id = ?", old.ID).
		Updates(map[string]any{"ended_at": now.Add(-70 * time.Hour), "ended_by": EndedByUser}).Error)

	// Closed inside the window: included.
	recent, err := repo.Start(context.Background(), userID, now.Add(-30*time.Hour), now)
	require.NoError(t, err)
	require.NoError(t, db.Model(&Interval{}).Where("id = ?", recent.ID).
		Updates(map[string]any{"ended_at": now.Add(-1 * time.Hour), "ended_by": EndedByUser}).Error)

	// Still open: included regardless of when it started.
	open, err := repo.Start(context.Background(), userID, now.Add(-2*time.Hour), now)
	require.NoError(t, err)

	out, err := repo.Since(context.Background(), userID, now.Add(-24*time.Hour))
	require.NoError(t, err)

	ids := make(map[uuid.UUID]bool, len(out))
	for _, in := range out {
		ids[in.ID] = true
	}
	require.False(t, ids[old.ID], "closed well before the window must be excluded")
	require.True(t, ids[recent.ID], "closed inside the window must be included")
	require.True(t, ids[open.ID], "still-open must be included regardless of start")
}
