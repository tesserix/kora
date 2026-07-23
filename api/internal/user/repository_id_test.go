package user

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func idTestDB(t *testing.T) *gorm.DB {
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

func TestIDByFirebaseUID(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "id-test-uid") })

	created, err := repo.UpsertByFirebaseUID(context.Background(), "id-test-uid", "id@test.dev")
	require.NoError(t, err)

	got, err := repo.IDByFirebaseUID(context.Background(), "id-test-uid")
	require.NoError(t, err)
	require.Equal(t, created.ID, got)
}

func TestIDByFirebaseUIDNotFound(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	_, err := repo.IDByFirebaseUID(context.Background(), "does-not-exist-uid")
	require.Error(t, err)
}

func TestEnsureUserProvisionsThenReturnsExisting(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "ensure-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	// First call provisions.
	u1, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev")
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, u1.ID)

	// Second call returns the same row without creating a duplicate.
	u2, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev")
	require.NoError(t, err)
	require.Equal(t, u1.ID, u2.ID)

	var count int64
	db.Model(&User{}).Where("firebase_uid = ?", fuid).Count(&count)
	require.Equal(t, int64(1), count)
}

func TestEnsureUserGetsDefaultTimezone(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "tz-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })
	u, err := repo.EnsureUser(context.Background(), fuid, "tz@test.dev")
	require.NoError(t, err)
	require.Equal(t, DefaultTimezone, u.Timezone)
}
