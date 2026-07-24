package ai

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
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
}

func TestCacheKey_StableAndNormalized(t *testing.T) {
	require.Equal(t, "phrase:grilled chicken", CacheKey("phrase", "  Grilled Chicken "))
	require.Equal(t, CacheKey("barcode", "12345"), CacheKey("barcode", "12345"))
	require.Equal(t, "barcode:12345", CacheKey("barcode", "12345"))
	require.Equal(t, "photo:abc123", CacheKey("photo", "ABC123"))
}

func TestRedisCache_RoundTrip(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()

	key := CacheKey("phrase", "grilled chicken")
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

	got, ok := cache.Get(ctx, CacheKey("phrase", "grilled chicken"))
	require.False(t, ok)
	require.Nil(t, got)

	// Set on a down client must not panic either.
	require.NotPanics(t, func() {
		cache.Set(ctx, CacheKey("phrase", "grilled chicken"), Resolution{Provenance: "test"})
	})
}
