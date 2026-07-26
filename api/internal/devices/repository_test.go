package devices

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

func seedUser(t *testing.T, db *gorm.DB, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "dv-"+id.String(), "dv-"+id.String()+"@test.dev", name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM device_tokens WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestUpsertReassignsTokenToNewUser(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	bob := seedUser(t, db, "Bob")
	ctx := context.Background()
	tok := "ExponentPushToken[" + uuid.NewString() + "]"

	require.NoError(t, repo.Upsert(ctx, alice, tok, "ios"))
	require.NoError(t, repo.Upsert(ctx, bob, tok, "android")) // same token, new user

	aliceTokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 0, "token reassigned away from alice")

	bobTokens, err := repo.ListForUser(ctx, bob)
	require.NoError(t, err)
	require.Len(t, bobTokens, 1)
	require.Equal(t, "android", bobTokens[0].Platform)
}

func TestDeleteByTokenIsUserScoped(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	bob := seedUser(t, db, "Bob")
	ctx := context.Background()
	aTok := "ExponentPushToken[" + uuid.NewString() + "]"
	bTok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, repo.Upsert(ctx, alice, aTok, "ios"))
	require.NoError(t, repo.Upsert(ctx, bob, bTok, "ios"))

	// bob cannot delete alice's token binding
	require.NoError(t, repo.DeleteByToken(ctx, bob, aTok))
	aliceTokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 1, "alice's token survives another user's delete")

	// alice deletes her own
	require.NoError(t, repo.DeleteByToken(ctx, alice, aTok))
	aliceTokens, err = repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 0)
}

func TestDeleteTokenPrunesRegardlessOfUser(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	ctx := context.Background()
	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, repo.Upsert(ctx, alice, tok, "ios"))

	require.NoError(t, repo.DeleteToken(ctx, tok)) // prune path (no user scope)
	tokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, tokens, 0)
}
