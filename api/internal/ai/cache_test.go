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

// --- generation counter ---
//
// These tests cover the mechanism a food mutation (Task 4) uses to
// invalidate every cache entry that might embed a given food's macros in one
// O(1) operation: bumping a generation counter that every physical cache key
// is scoped by. Cache keys carry no food id (see CacheKey's doc), so there is
// no reverse index to walk instead.

// TestGenerationScopedKey_DiffersAcrossGenerations pins the low-level
// building block: the same logical key produces a different physical key
// under a different generation, and the same physical key under a repeated
// call with the same generation (stability within one generation).
func TestGenerationScopedKey_DiffersAcrossGenerations(t *testing.T) {
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	require.NotEqual(t, generationScopedKey(key, 0), generationScopedKey(key, 1),
		"two keys built under different generations must differ")
	require.Equal(t, generationScopedKey(key, 3), generationScopedKey(key, 3),
		"the same key under the same generation must be stable across calls")
}

// TestRedisCache_Generation_KeyStableWithinOneGeneration is the positive
// counterpart to the invalidation test below: as long as nobody bumps the
// generation, repeated Get calls for the same logical key must keep hitting
// the same entry — the generation scoping must not itself cause spurious
// misses.
func TestRedisCache_Generation_KeyStableWithinOneGeneration(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "brekkie bowl")

	cache.Set(ctx, key, Resolution{Provenance: "stable"})

	for i := 0; i < 3; i++ {
		got, ok := cache.Get(ctx, key)
		require.True(t, ok, "call %d: entry must still be reachable within the same generation", i)
		require.Equal(t, "stable", got.Provenance)
	}
}

// TestRedisCache_BumpGeneration_MakesPriorEntryUnreadable is the actual
// point of the feature: after BumpGeneration, a value written before the
// bump is no longer readable via a freshly built key for the exact same
// logical (kind, user, value) — not merely "the strings differ", but the
// entry is genuinely gone from the caller's perspective. It ages out on its
// own TTL rather than being actively deleted.
func TestRedisCache_BumpGeneration_MakesPriorEntryUnreadable(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	userID := uuid.New()
	key := CacheKey("phrase", userID, "grilled chicken")

	cache.Set(ctx, key, Resolution{Provenance: "pre-bump"})

	// Sanity: the entry is reachable before the bump.
	got, ok := cache.Get(ctx, key)
	require.True(t, ok, "sanity: entry must be present before the bump")
	require.Equal(t, "pre-bump", got.Provenance)

	require.NoError(t, cache.BumpGeneration(ctx))

	// A freshly built key for the identical (kind, user, value) must now
	// miss — the mutation that bumped the generation had no way to know
	// which specific cache keys reference the food it just edited (keys
	// carry no food id), so invalidation works by making every key built
	// under the old generation unreachable, not by targeting this one.
	freshKey := CacheKey("phrase", userID, "grilled chicken")
	require.Equal(t, key, freshKey, "sanity: CacheKey itself is generation-agnostic and stays stable")

	got, ok = cache.Get(ctx, freshKey)
	require.False(t, ok, "a value written before a generation bump must not be readable via a fresh key")
	require.Nil(t, got)
}

// TestRedisCache_BumpGeneration_IsMonotonicallyIncrementing exercises
// CurrentGeneration/BumpGeneration directly: repeated bumps strictly
// increase the counter, and it starts at the baseline (0) before any bump
// has ever happened.
func TestRedisCache_BumpGeneration_IsMonotonicallyIncrementing(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()

	baseline, err := cache.CurrentGeneration(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(0), baseline, "an un-bumped cache must report the baseline generation")

	require.NoError(t, cache.BumpGeneration(ctx))
	first, err := cache.CurrentGeneration(ctx)
	require.NoError(t, err)
	require.Equal(t, baseline+1, first)

	require.NoError(t, cache.BumpGeneration(ctx))
	second, err := cache.CurrentGeneration(ctx)
	require.NoError(t, err)
	require.Equal(t, first+1, second)
}

// TestRedisCache_GenerationReadFailure_NeverFallsBackToCollidingGeneration
// is the regression test for the failure mode this design was chosen
// against: a FIXED fallback generation would be wrong specifically because
// generation 0 is not a made-up placeholder — it is the real, valid
// generation every entry was written under before the very first bump ever
// happened. If a failed generation read fell back to a fixed value that
// collided with a real past generation, it would silently serve back a
// stale, pre-bump entry the moment Redis's generation counter becomes
// unreadable while the rest of Redis (and that stale entry's TTL) is still
// live. This test reproduces exactly that: it corrupts ONLY the generation
// counter key (leaving the rest of Redis healthy, unlike a full outage) and
// asserts the read failure is instead treated as "cache absent" — a
// guaranteed miss, never a stale hit.
func TestRedisCache_GenerationReadFailure_NeverFallsBackToCollidingGeneration(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	// Written under the baseline generation (0), before any bump has ever
	// happened — this is the entry a fixed fallback-to-0 would wrongly
	// resurrect.
	cache.Set(ctx, key, Resolution{Provenance: "stale-pre-bump"})

	require.NoError(t, cache.BumpGeneration(ctx))

	// Corrupt just the generation counter so reading it fails while the
	// rest of Redis — including the stale entry above — stays reachable.
	require.NoError(t, mr.Set(resolveCacheGenerationKey, "not-an-integer"))

	_, err = cache.CurrentGeneration(ctx)
	require.Error(t, err, "a corrupted generation counter must surface as a read failure, not a silently-wrong value")

	got, ok := cache.Get(ctx, key)
	require.False(t, ok, "a generation read failure must never fall back to a generation that could collide with a real past one")
	require.Nil(t, got)

	// Set must degrade the same way: it must not write under a guessed
	// generation while the counter is unreadable.
	require.NotPanics(t, func() {
		cache.Set(ctx, key, Resolution{Provenance: "written-during-corruption"})
	})

	// Delete must report the failure (so the one real caller,
	// foodlog.Service's correction invalidation, can log it) rather than
	// claiming success while doing nothing.
	require.Error(t, cache.Delete(ctx, key))
}

// TestNoCache_GenerationIsInertNoOp pins NoCache's contract for the new
// surface: a fixed, meaningless generation and a silent no-op bump, so
// nothing on the admin mutation path has to special-case "caching is off".
func TestNoCache_GenerationIsInertNoOp(t *testing.T) {
	c := NoCache{}
	ctx := context.Background()

	gen, err := c.CurrentGeneration(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(0), gen)

	require.NotPanics(t, func() {
		require.NoError(t, c.BumpGeneration(ctx))
	})

	// Bumping must not change NoCache's always-miss behaviour.
	got, ok := c.Get(ctx, "anything")
	require.False(t, ok)
	require.Nil(t, got)
}
