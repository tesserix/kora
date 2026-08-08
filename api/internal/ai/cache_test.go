package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
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

// newTestRedisCache builds a RedisCache backed by a fresh miniredis instance,
// closing both the miniredis server and the redis client via t.Cleanup. The
// *miniredis.Miniredis handle is returned alongside the cache so tests can
// reach in and manipulate/inspect physical keys directly (e.g. mr.Set,
// mr.Exists) the way the generation-counter-eviction tests already do below.
func newTestRedisCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	return NewRedisCache(client, time.Minute), mr
}

// TestRedisCacheDeleteByUserRemovesAllKindsAndGenerations is the regression
// test for account deletion's Redis eviction: DeleteByUser must sweep every
// kind (phrase/photo/voice) AND every generation for the victim user, while
// leaving another user's entries under the same kinds completely untouched —
// the survivor assertions are what catch an over-broad sweep that deletes
// everything instead of scoping to userID.
func TestRedisCacheDeleteByUserRemovesAllKindsAndGenerations(t *testing.T) {
	c, mr := newTestRedisCache(t)
	ctx := context.Background()
	victim, survivor := uuid.New(), uuid.New()

	for _, kind := range []string{"phrase", "photo", "voice"} {
		c.Set(ctx, CacheKey(kind, victim, "x"), Resolution{})
		c.Set(ctx, CacheKey(kind, survivor, "x"), Resolution{})
	}
	// A key left behind from an older generation must go too.
	require.NoError(t, mr.Set("phrase:"+victim.String()+":stale:g0", "{}"))

	require.NoError(t, c.DeleteByUser(ctx, victim))

	for _, kind := range []string{"phrase", "photo", "voice"} {
		_, ok := c.Get(ctx, CacheKey(kind, victim, "x"))
		assert.False(t, ok, "victim %s entry must be gone", kind)
		_, ok = c.Get(ctx, CacheKey(kind, survivor, "x"))
		assert.True(t, ok, "survivor %s entry must remain", kind)
	}
	assert.False(t, mr.Exists("phrase:"+victim.String()+":stale:g0"),
		"older-generation key must be swept too")
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

// TestRedisCache_KeyIsGenerationScoped_NotBareLogicalKey replaces the former
// TestRedisCache_Generation_KeyStableWithinOneGeneration, which — despite its
// name — proved nothing generation-specific: it only asserted that repeated
// Get calls after one Set kept succeeding, which TestRedisCache_RoundTrip
// already covers, and it stayed green even against a generationScopedKey
// stub that ignored its generation argument entirely (e.g. `return key`).
// Renaming alone would have fixed the misleading name but left the test
// still vacuous, so this version also strengthens it: it asserts the entry
// physically lives under the generation-0 SCOPED key and is NOT reachable
// under the bare, unscoped logical key — the one property a stubbed
// generationScopedKey would violate. It keeps the original repeated-Get
// stability check too, since that's still a real (if weaker) property worth
// pinning.
func TestRedisCache_KeyIsGenerationScoped_NotBareLogicalKey(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "brekkie bowl")

	cache.Set(ctx, key, Resolution{Provenance: "stable"})

	// The entry must live under the generation-0 scoped physical key...
	scoped, err := client.Get(ctx, generationScopedKey(key, 0)).Bytes()
	require.NoError(t, err, "the entry must be stored under the generation-0 scoped key")
	var r Resolution
	require.NoError(t, json.Unmarshal(scoped, &r))
	require.Equal(t, "stable", r.Provenance)

	// ...and NEVER under the bare, unscoped logical key — otherwise
	// generation scoping isn't actually happening, and a later bump could
	// never hide this entry.
	_, err = client.Get(ctx, key).Result()
	require.ErrorIs(t, err, redis.Nil, "the entry must not be reachable under the bare, unscoped logical key")

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
	// generation while the counter is unreadable. require.NotPanics alone
	// does not pin this — it also passes against a Set that falls back to
	// writing under a fixed generation 0, which is exactly the bug this
	// design decision was made against (see the corresponding assertion
	// below, which does pin it).
	require.NotPanics(t, func() {
		cache.Set(ctx, key, Resolution{Provenance: "written-during-corruption"})
	})

	// Delete must report the failure (so the one real caller,
	// foodlog.Service's correction invalidation, can log it) rather than
	// claiming success while doing nothing.
	require.Error(t, cache.Delete(ctx, key))

	// Restore the counter to its real, post-bump value and directly inspect
	// the physical generation-0 key the corrupted Set above would have
	// written to had it (wrongly) fallen back to a fixed generation 0. It
	// must still hold only the original pre-bump write ("stale-pre-bump"),
	// never "written-during-corruption" — proving Set actually skipped the
	// write during the read failure, not just that it avoided panicking.
	require.NoError(t, mr.Set(resolveCacheGenerationKey, "1"))

	rawAtGenerationZero, err := client.Get(ctx, generationScopedKey(key, 0)).Bytes()
	require.NoError(t, err, "the original pre-bump entry must still be the only thing at the generation-0 key")
	var r Resolution
	require.NoError(t, json.Unmarshal(rawAtGenerationZero, &r))
	require.NotEqual(t, "written-during-corruption", r.Provenance,
		"Set must never have fallen back to writing under a guessed generation 0 during the read failure")
	require.Equal(t, "stale-pre-bump", r.Provenance)
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

// --- generation counter eviction (high-water-mark guard) ---
//
// The generation counter key is deliberately persistent — no TTL, and INCR
// attaches none — so its own expiry can never be the failure vector. But
// allkeys-lru and allkeys-random, the conventional maxmemory-policy choices
// for a Redis used purely as a cache, evict keys under memory pressure
// regardless of TTL. No Redis configuration exists anywhere in this repo yet
// (see resolveCacheGenerationKey's doc comment), so nothing stops whoever
// enables Redis from choosing one of those. If the counter key is evicted
// after a real bump, a bare re-read reports the same redis.Nil it would for
// "never bumped" — resetting the effective generation back to 0 and
// resurrecting every pre-bump entry until its TTL happens to expire, with no
// error anywhere. RedisCache.generationHWM (see readGeneration) closes this
// by treating an observed generation lower than any generation this process
// has already seen as a read failure instead of a valid value.

// TestRedisCache_GenerationCounterEvicted_PreBumpEntryStaysHidden is the
// reviewer's repro for the eviction hole, end to end: Set, Bump, confirm the
// entry is hidden, delete the counter key (simulating eviction under
// allkeys-lru/allkeys-random), and confirm the pre-bump entry is STILL not
// served.
func TestRedisCache_GenerationCounterEvicted_PreBumpEntryStaysHidden(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	cache.Set(ctx, key, Resolution{Provenance: "pre-bump"})

	require.NoError(t, cache.BumpGeneration(ctx))

	// Sanity: the bump alone already hides the entry, before any eviction.
	_, ok := cache.Get(ctx, key)
	require.False(t, ok, "sanity: bump must hide the pre-bump entry on its own")

	// Simulate a maxmemory-policy eviction of the (persistent, no-TTL)
	// generation counter.
	require.True(t, mr.Del(resolveCacheGenerationKey), "sanity: counter key must have existed to evict")

	got, ok := cache.Get(ctx, key)
	require.False(t, ok, "an evicted generation counter must never resurrect a pre-bump entry")
	require.Nil(t, got)
}

// TestRedisCache_GenerationRead_StillSucceedsWhenCounterIntact is the twin
// of the eviction test above: the high-water-mark guard must only reject a
// generation that has genuinely regressed, never an ordinary read of an
// intact counter. Without this test, a change that made every generation
// read fail (not just regressed ones) would pass the eviction test alone.
func TestRedisCache_GenerationRead_StillSucceedsWhenCounterIntact(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	cache.Set(ctx, key, Resolution{Provenance: "current"})
	got, ok := cache.Get(ctx, key)
	require.True(t, ok, "an ordinary, non-evicted read must still succeed")
	require.Equal(t, "current", got.Provenance)

	require.NoError(t, cache.BumpGeneration(ctx))
	cache.Set(ctx, key, Resolution{Provenance: "post-bump"})

	got, ok = cache.Get(ctx, key)
	require.True(t, ok, "a fresh write under an intact, higher generation must still be reachable")
	require.Equal(t, "post-bump", got.Provenance)
}

// TestRedisCache_ConcurrentGenerationReads_AreRaceFree exercises the
// high-water-mark guard's concurrency requirement directly: the hot resolve
// path calls Get from many goroutines at once, so the guard must be safe
// under concurrent access without serializing every cache read behind a
// lock. Meaningful under `go test -race`.
func TestRedisCache_ConcurrentGenerationReads_AreRaceFree(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")
	cache.Set(ctx, key, Resolution{Provenance: "concurrent"})

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = cache.Get(ctx, key)
			_, _ = cache.CurrentGeneration(ctx)
		}()
	}
	wg.Wait()

	got, ok := cache.Get(ctx, key)
	require.True(t, ok, "concurrent reads must not corrupt the high-water mark for a still-valid generation")
	require.Equal(t, "concurrent", got.Provenance)
}

// --- generation counter eviction observability (rate-limited warning) ---
//
// The high-water-mark guard closes the eviction hole silently: Get and Set
// both swallow the resulting error by contract, so a tripped guard has no
// symptom other than a step-change in resolve latency and LLM spend, with
// the bill as the only diagnostic. warnGenerationGuardTripped exists to give
// an operator a log line the moment that happens.

// captureSlogWarnings temporarily redirects the process-wide slog default to
// a text handler writing into the returned buffer, restoring the previous
// default via t.Cleanup. No test in this package runs in parallel, so
// mutating the global default for the duration of one test is safe.
func captureSlogWarnings(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// TestRedisCache_GenerationGuardTripped_LogsWarning proves the guard's trip
// is observable: it reproduces the eviction hole (Set, Bump, evict the
// counter key) and asserts a warning is logged when the resulting Get trips
// the high-water-mark guard.
func TestRedisCache_GenerationGuardTripped_LogsWarning(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	cache.Set(ctx, key, Resolution{Provenance: "pre-bump"})
	require.NoError(t, cache.BumpGeneration(ctx))

	// Sanity: the bump alone already hides the entry, before any eviction.
	// This read is also what makes the guard observe generation 1 in the
	// first place — BumpGeneration itself never calls readGeneration, so
	// without this the high-water mark would still be 0 and the eviction
	// below would not be a regression at all.
	_, ok := cache.Get(ctx, key)
	require.False(t, ok, "sanity: bump must hide the pre-bump entry on its own")

	buf := captureSlogWarnings(t)

	// Simulate a maxmemory-policy eviction of the (persistent, no-TTL)
	// generation counter after the legitimate bump above.
	require.True(t, mr.Del(resolveCacheGenerationKey), "sanity: counter key must have existed to evict")

	_, ok = cache.Get(ctx, key)
	require.False(t, ok, "sanity: the guard must still trip and hide the pre-bump entry")

	require.Contains(t, buf.String(), "high-water-mark guard tripped",
		"the guard tripping must be logged — Get/Set swallow the error, so this is the only observable signal")
}

// TestRedisCache_GenerationGuardNotTripped_NoWarning is the twin of the test
// above: ordinary cache traffic — misses, hits, and legitimate generation
// bumps — must never log anything. Without this test, a change that logged
// on every ordinary read (or every miss, or every bump) would still pass the
// trip test alone.
func TestRedisCache_GenerationGuardNotTripped_NoWarning(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	buf := captureSlogWarnings(t)

	// An ordinary miss before anything is cached.
	_, ok := cache.Get(ctx, key)
	require.False(t, ok)

	// An ordinary write and hit.
	cache.Set(ctx, key, Resolution{Provenance: "ordinary"})
	got, ok := cache.Get(ctx, key)
	require.True(t, ok)
	require.Equal(t, "ordinary", got.Provenance)

	// A legitimate bump followed by a read/write under the new, higher
	// generation — this must NOT look like a regression to the guard.
	require.NoError(t, cache.BumpGeneration(ctx))
	cache.Set(ctx, key, Resolution{Provenance: "post-bump"})
	got, ok = cache.Get(ctx, key)
	require.True(t, ok)
	require.Equal(t, "post-bump", got.Provenance)

	_, err = cache.CurrentGeneration(ctx)
	require.NoError(t, err)

	require.Empty(t, buf.String(), "ordinary cache operations must never log the high-water-mark guard warning")
}

// TestRedisCache_GenerationGuardTripped_WarningIsRateLimitedUnderConcurrency
// exercises the rate limit's concurrency-safety requirement directly: many
// goroutines tripping the guard at once (the hot resolve path's real shape)
// must still produce only a bounded, small number of log lines — never one
// per caller — and the CAS-based gate must not race under `go test -race`.
func TestRedisCache_GenerationGuardTripped_WarningIsRateLimitedUnderConcurrency(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()

	cache := NewRedisCache(client, time.Minute)
	ctx := context.Background()
	key := CacheKey("phrase", uuid.New(), "grilled chicken")

	cache.Set(ctx, key, Resolution{Provenance: "pre-bump"})
	require.NoError(t, cache.BumpGeneration(ctx))

	// See TestRedisCache_GenerationGuardTripped_LogsWarning: this read is
	// what makes the guard observe generation 1 before the eviction below,
	// since BumpGeneration alone never advances the high-water mark.
	_, ok := cache.Get(ctx, key)
	require.False(t, ok, "sanity: bump must hide the pre-bump entry on its own")

	require.True(t, mr.Del(resolveCacheGenerationKey))

	buf := captureSlogWarnings(t)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = cache.Get(ctx, key)
		}()
	}
	wg.Wait()

	count := strings.Count(buf.String(), "high-water-mark guard tripped")
	require.Equal(t, 1, count,
		"50 concurrent trips within one rate-limit window must produce exactly one warning, not 50")
}
