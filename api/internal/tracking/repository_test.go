package tracking

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
		id, "tr-"+id.String(), "tr@test.dev").Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM water_entries WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestAddWaterHappyPath(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	entry, err := repo.AddWater(context.Background(), userID, 500, time.Now())
	require.NoError(t, err)
	require.Equal(t, 500, entry.VolumeML)
	require.NotEqual(t, uuid.Nil, entry.ID)
}

func TestAddWaterRejectsNonPositiveVolume(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, err := repo.AddWater(context.Background(), userID, 0, time.Time{})
	require.Error(t, err)

	_, err = repo.AddWater(context.Background(), userID, -100, time.Now())
	require.Error(t, err)
}

func TestAddWaterDefaultsLoggedAtWhenZero(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	entry, err := repo.AddWater(context.Background(), userID, 250, time.Time{})
	require.NoError(t, err)
	require.False(t, entry.LoggedAt.IsZero())
}

func TestWaterTotalForDaySumsSameDayAndExcludesOtherDays(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	dayD := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	dayD2 := time.Date(2026, 3, 3, 9, 0, 0, 0, time.UTC)
	dayNone := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)

	_, err := repo.AddWater(context.Background(), userID, 250, dayD)
	require.NoError(t, err)
	_, err = repo.AddWater(context.Background(), userID, 500, dayD.Add(2*time.Hour))
	require.NoError(t, err)
	_, err = repo.AddWater(context.Background(), userID, 1000, dayD2)
	require.NoError(t, err)

	total, err := repo.WaterTotalForDay(context.Background(), userID, dayD, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 750, total)

	total, err = repo.WaterTotalForDay(context.Background(), userID, dayD2, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 1000, total)

	total, err = repo.WaterTotalForDay(context.Background(), userID, dayNone, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 0, total)
}
