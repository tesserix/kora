package feedback

import (
	"context"
	"os"
	"testing"

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

// seedUser inserts a bare user row and returns its id. Feedback has no need
// for the kcal/protein targets coach's seedUser carries — a feedback row
// only needs a valid user to satisfy the foreign key.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "feedback-"+id.String(), "feedback-"+id.String()+"@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func TestRepository_CreateRoundTrip(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	saved, err := repo.Create(context.Background(), Feedback{
		UserID:      userID,
		Kind:        KindBug,
		Subject:     "Camera freezes on capture",
		Description: "Tapping the shutter freezes the app for ~5s.",
		Status:      StatusOpen,
		AppVersion:  "1.0.0",
		Platform:    "ios",
		OSVersion:   "26.1",
		DeviceModel: "iPhone17,2",
	})
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, saved.ID, "the database must assign an id")
	require.False(t, saved.CreatedAt.IsZero(), "created_at must be populated")

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", saved.ID).Error)
	require.Equal(t, userID, got.UserID)
	require.Equal(t, KindBug, got.Kind)
	require.Equal(t, "Camera freezes on capture", got.Subject)
	require.Equal(t, StatusOpen, got.Status)
	require.Equal(t, "ios", got.Platform)
	require.Equal(t, "iPhone17,2", got.DeviceModel)
}

func TestRepository_CreateDefaultsStatusToOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	saved, err := repo.Create(context.Background(), Feedback{
		UserID: userID, Kind: KindFeature, Subject: "Dark mode", Description: "Please.",
	})
	require.NoError(t, err)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", saved.ID).Error)
	require.Equal(t, StatusOpen, got.Status, "the column default must apply when the caller omits status")
}
