package ai

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestNoCache_AlwaysMisses(t *testing.T) {
	c := NoCache{}
	ctx := context.Background()

	got, ok := c.Get(ctx, "anything")
	require.False(t, ok)
	require.Nil(t, got)

	// Set must be a no-op and must not panic.
	require.NotPanics(t, func() {
		c.Set(ctx, "anything", Resolution{Provenance: "test"})
	})

	got, ok = c.Get(ctx, "anything")
	require.False(t, ok)
	require.Nil(t, got)

	require.NoError(t, c.Delete(ctx, "anything"), "Delete on NoCache must be a no-op, never an error")
}

func TestCacheKey_StableAndNormalized(t *testing.T) {
	u := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	require.Equal(t, "phrase:"+u.String()+":grilled chicken", CacheKey("phrase", u, "  Grilled Chicken "))
	require.Equal(t, CacheKey("barcode", u, "12345"), CacheKey("barcode", u, "12345"))
	require.Equal(t, "barcode:"+u.String()+":12345", CacheKey("barcode", u, "12345"))
	require.Equal(t, "photo:"+u.String()+":abc123", CacheKey("photo", u, "ABC123"))
}

// TestCacheKey_ScopedByUser is the finding-1 regression test: resolution is
// user-dependent (personal food_aliases outrank curated/global ones), so the
// cache key must be too. Two different users must never collide on the same
// key for the same input, and the same user must always produce the same
// key across calls — otherwise one user's cached Resolution (and its
// nutrition numbers) could be served to a different user.
func TestCacheKey_ScopedByUser(t *testing.T) {
	userA := uuid.New()
	userB := uuid.New()

	keyA := CacheKey("phrase", userA, "brekkie bowl")
	keyB := CacheKey("phrase", userB, "brekkie bowl")
	require.NotEqual(t, keyA, keyB, "different users must not share a cache key for the same value")

	require.Equal(t, keyA, CacheKey("phrase", userA, "brekkie bowl"),
		"the same user must get a stable key across calls")
	require.Equal(t, keyA, CacheKey("phrase", userA, "  Brekkie Bowl "),
		"the same user must get a stable key regardless of case/whitespace")
}

func TestRedisCache_RoundTrip(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()

	key := CacheKey("phrase", uuid.New(), "grilled chicken")
	want := Resolution{
		Candidates: []ResolvedCandidate{
			{PortionGrams: 150, Kcal: 231, MatchScore: 0.95, MatchTier: "auto"},
		},
		Tier:       TierAuto,
		IsEstimate: false,
		Provenance: "nutrition_index",
	}

	// Miss before Set.
	got, ok := cache.Get(ctx, key)
	require.False(t, ok)
	require.Nil(t, got)

	cache.Set(ctx, key, want)

	got, ok = cache.Get(ctx, key)
	require.True(t, ok)
	require.NotNil(t, got)
	require.Equal(t, want.Tier, got.Tier)
	require.Equal(t, want.Provenance, got.Provenance)
	require.Equal(t, want.IsEstimate, got.IsEstimate)
	require.Len(t, got.Candidates, 1)
	require.Equal(t, want.Candidates[0].Kcal, got.Candidates[0].Kcal)
	require.Equal(t, want.Candidates[0].MatchScore, got.Candidates[0].MatchScore)
}

// TestRedisCache_Delete_RemovesEntry is the regression test for the
// foodlog correction-cache invalidation fix: a stale Resolution cached
// before a correction must actually be gone from Redis after Delete, not
// just reported as gone.
func TestRedisCache_Delete_RemovesEntry(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "brekkie bowl")

	cache.Set(ctx, key, Resolution{Provenance: "test"})
	_, ok := cache.Get(ctx, key)
	require.True(t, ok, "sanity: entry must be present before Delete")

	require.NoError(t, cache.Delete(ctx, key))

	_, ok = cache.Get(ctx, key)
	require.False(t, ok, "entry must be gone after Delete")
}

// TestRedisCache_Delete_MissingKeyIsNotAnError matches Get/Set's contract:
// deleting a key that was never cached (or already expired) must not be
// treated as a failure.
func TestRedisCache_Delete_MissingKeyIsNotAnError(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	require.NoError(t, cache.Delete(context.Background(), CacheKey("phrase", uuid.New(), "never cached")))
}

func TestRedisCache_DownRedisIsNilSafe(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)

	client := redis.NewClient(&redis.Options{
		Addr:       mr.Addr(),
		MaxRetries: -1, // fail fast; a down cache must not slow down resolution
	})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()

	// Bring redis down.
	mr.Close()

	got, ok := cache.Get(ctx, CacheKey("phrase", uuid.New(), "grilled chicken"))
	require.False(t, ok)
	require.Nil(t, got)

	// Set on a down client must not panic either.
	require.NotPanics(t, func() {
		cache.Set(ctx, CacheKey("phrase", uuid.New(), "grilled chicken"), Resolution{Provenance: "test"})
	})
}
