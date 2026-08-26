package platformauth

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func nonceTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)

	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

// TestClaimIsSingleUse — this is the whole replay defence. It must be the
// DATABASE deciding, not a read-then-write in Go, so that two pods racing the
// same captured request cannot both win.
func TestClaimIsSingleUse(t *testing.T) {
	store := NewNonceStore(nonceTestDB(t))
	nonce := uuid.NewString()
	expires := time.Now().Add(5 * time.Minute)

	first, err := store.Claim(context.Background(), nonce, expires)
	require.NoError(t, err)
	assert.True(t, first)

	second, err := store.Claim(context.Background(), nonce, expires)
	require.NoError(t, err)
	assert.False(t, second, "the second use of a nonce is a replay")
}

func TestClaimAcceptsDistinctNonces(t *testing.T) {
	store := NewNonceStore(nonceTestDB(t))
	expires := time.Now().Add(5 * time.Minute)

	for range 3 {
		fresh, err := store.Claim(context.Background(), uuid.NewString(), expires)
		require.NoError(t, err)
		assert.True(t, fresh)
	}
}

// TestClaimAcceptsTheFederationClientsBareHexNonce — the console's client
// emits 128 bits of undashed hex, not a dashed UUID. If uuid.Parse rejected
// that form, every federated call would 401 with "nonce replayed or
// unverifiable" and nothing would point at the encoding.
func TestClaimAcceptsTheFederationClientsBareHexNonce(t *testing.T) {
	store := NewNonceStore(nonceTestDB(t))

	fresh, err := store.Claim(context.Background(),
		"018f3c2a000070008000000000000001", time.Now().Add(5*time.Minute))
	require.NoError(t, err)
	assert.True(t, fresh)
}

// TestClaimRejectsANonUUIDNonce — an unparseable nonce is an error, never a
// successful claim. Middleware treats any error as a rejection.
func TestClaimRejectsANonUUIDNonce(t *testing.T) {
	store := NewNonceStore(nonceTestDB(t))

	fresh, err := store.Claim(context.Background(), "not-a-nonce", time.Now().Add(time.Minute))
	require.Error(t, err)
	assert.False(t, fresh)
}

// TestSweepDeletesOnlyExpiredRows — a sweep that took a live nonce would
// make an in-flight request replayable, which is worse than never sweeping.
func TestSweepDeletesOnlyExpiredRows(t *testing.T) {
	tx := nonceTestDB(t)
	store := NewNonceStore(tx)
	ctx := context.Background()

	live, expired := uuid.NewString(), uuid.NewString()
	_, err := store.Claim(ctx, live, time.Now().Add(5*time.Minute))
	require.NoError(t, err)
	_, err = store.Claim(ctx, expired, time.Now().Add(-time.Minute))
	require.NoError(t, err)

	removed, err := SweepExpiredNonces(ctx, tx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, removed, int64(1))

	// The live nonce must still be claimed — a re-claim reports replay.
	stillClaimed, err := store.Claim(ctx, live, time.Now().Add(5*time.Minute))
	require.NoError(t, err)
	assert.False(t, stillClaimed, "the sweep removed a nonce that had not expired")

	// The expired one is gone, so its nonce is claimable again. That is
	// correct: it is past the window the signature is valid for.
	reclaimable, err := store.Claim(ctx, expired, time.Now().Add(5*time.Minute))
	require.NoError(t, err)
	assert.True(t, reclaimable)
}
