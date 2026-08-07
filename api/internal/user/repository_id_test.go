package user

import (
	"context"
	"os"
	"strings"
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
	u1, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev", "")
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, u1.ID)

	// Second call returns the same row without creating a duplicate.
	u2, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev", "")
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
	u, err := repo.EnsureUser(context.Background(), fuid, "tz@test.dev", "")
	require.NoError(t, err)
	require.Equal(t, DefaultTimezone, u.Timezone)
}

func TestEnsureUserSeedsDisplayNameOnNewUser(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-new-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	u, err := repo.EnsureUser(context.Background(), fuid, "seed-new@test.dev", "Ada Lovelace")
	require.NoError(t, err)
	require.Equal(t, "Ada Lovelace", u.DisplayName)

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Equal(t, "Ada Lovelace", stored.DisplayName)
}

func TestEnsureUserRepairsEmptyDisplayNameOnExistingUser(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-repair-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	// Provision the row first with no name, mirroring an existing Google user
	// whose display_name is '' because the claim used to be discarded.
	created, err := repo.UpsertByFirebaseUID(context.Background(), fuid, "seed-repair@test.dev")
	require.NoError(t, err)
	require.Empty(t, created.DisplayName)

	u, err := repo.EnsureUser(context.Background(), fuid, "seed-repair@test.dev", "Grace Hopper")
	require.NoError(t, err)
	require.Equal(t, "Grace Hopper", u.DisplayName)

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Equal(t, "Grace Hopper", stored.DisplayName)
}

func TestEnsureUserDoesNotOverwriteExistingDisplayName(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-noclobber-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	created, err := repo.UpsertByFirebaseUID(context.Background(), fuid, "seed-noclobber@test.dev")
	require.NoError(t, err)
	require.NoError(t, repo.SetDisplayName(context.Background(), created.ID, "My Chosen Name"))

	// A later Google sign-in carries a different name claim; it must not
	// clobber the name the user already chose via SetDisplayName.
	u, err := repo.EnsureUser(context.Background(), fuid, "seed-noclobber@test.dev", "Different Claim Name")
	require.NoError(t, err)
	require.Equal(t, "My Chosen Name", u.DisplayName)

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Equal(t, "My Chosen Name", stored.DisplayName)
}

func TestEnsureUserWhitespaceOnlyNameWritesNothing(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-blank-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	u, err := repo.EnsureUser(context.Background(), fuid, "seed-blank@test.dev", "   \t  ")
	require.NoError(t, err)
	require.Empty(t, u.DisplayName)

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Empty(t, stored.DisplayName)
}

func TestEnsureUserSeedFailureDoesNotFailWholeCall(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-writefail-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	// Provision the row first (with a live context) so the row exists with
	// display_name == '' before we force the seed write itself to fail.
	created, err := repo.UpsertByFirebaseUID(context.Background(), fuid, "seed-writefail@test.dev")
	require.NoError(t, err)
	require.Empty(t, created.DisplayName)

	// Force SetDisplayName's write to genuinely fail, without touching
	// Repository: register a GORM "after query" callback that cancels the
	// context exactly once, right after EnsureUser's initial lookup query
	// completes but before the seed UPDATE runs. GORM surfaces a cancelled
	// context as a real query error (context.Canceled) on .Error, so the
	// seed write genuinely fails at the database layer rather than being
	// contrived to never reach the failure branch. The callback is
	// registered on the shared *gorm.DB and removed via defer so it does
	// not leak into other tests in this package.
	cancelCtx, cancel := context.WithCancel(context.Background())
	fired := false
	require.NoError(t, db.Callback().Query().After("gorm:query").Register(
		"test-cancel-after-lookup",
		func(tx *gorm.DB) {
			if !fired && tx.Statement.Table == "users" {
				fired = true
				cancel()
			}
		},
	))
	t.Cleanup(func() { db.Callback().Query().Remove("test-cancel-after-lookup") })

	u, err := repo.EnsureUser(cancelCtx, fuid, "seed-writefail@test.dev", "Should Not Persist")
	require.NoError(t, err, "EnsureUser must not fail the whole call when the display_name seed write fails")
	require.True(t, fired, "the cancel-after-lookup callback must have fired, or this test isn't exercising the intended failure")
	require.Empty(t, u.DisplayName, "returned user must reflect what is actually persisted, not the un-written seed")

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Empty(t, stored.DisplayName, "seed write must not have persisted")
}

func TestEnsureUserOverLongNameWritesNothing(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "seed-toolong-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	tooLong := strings.Repeat("a", MaxDisplayNameLen+1)
	u, err := repo.EnsureUser(context.Background(), fuid, "seed-toolong@test.dev", tooLong)
	require.NoError(t, err)
	require.Empty(t, u.DisplayName)

	var stored User
	require.NoError(t, db.Where("firebase_uid = ?", fuid).First(&stored).Error)
	require.Empty(t, stored.DisplayName)
}
