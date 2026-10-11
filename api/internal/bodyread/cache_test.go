package bodyread

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

// newTestRedisCache builds a RedisCache backed by a fresh miniredis
// instance, closing both via t.Cleanup — mirrors internal/ai/cache_test.go's
// newTestRedisCache exactly, so the two packages' Redis-backed cache tests
// stay recognizable siblings of each other.
func newTestRedisCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	return NewRedisCache(client, time.Hour), mr
}

func ptrf(f float64) *float64 { return &f }
func ptrs(s string) *string   { return &s }

// TestRedisCache_RoundTrip is the regression test flagged as a gap in
// kora#314's Task 4 review (Minor 4): a JSON round trip is exactly where a
// *float64-heavy Result (this package's whole point is "absent must never
// become zero") could silently regress a nil into a 0.0 without anyone
// noticing, since Go's encoding/json treats an omitted pointer field and an
// explicit `null` the same way on decode, but a BUG in Result's tags or a
// non-pointer field slipping in would not.
func TestRedisCache_RoundTrip(t *testing.T) {
	cache, _ := newTestRedisCache(t)
	ctx := context.Background()
	userID := uuid.New()
	key := ai.CacheKey("body_composition", userID, "somehash")

	want := Result{
		Reading: ai.BodyCompositionReading{
			WeightKg:    ptrf(72.4),
			BodyFatPct:  ptrf(18.2),
			ReadingDate: ptrs("2026-08-20"),
			// SkeletalMusclePct, MuscleMassKg, and every other field left
			// nil on purpose — the round trip must preserve that, not turn
			// it into 0.0.
		},
		Dropped: []DroppedField{
			{Field: "scale_bmr_kcal", Reason: "non-positive"},
		},
		Unreadable: false,
	}

	cache.Set(ctx, key, want)
	got, ok := cache.Get(ctx, key)

	require.True(t, ok)
	require.NotNil(t, got)
	assert.Equal(t, want, *got)
	// The specific regression this test guards: absent fields must decode
	// to nil, never to a real *float64 pointing at 0.0.
	assert.Nil(t, got.Reading.SkeletalMusclePct)
	assert.Nil(t, got.Reading.MuscleMassKg)
	assert.Nil(t, got.Reading.BoneMassKg)
}

// TestRedisCache_Get_MissReturnsFalse mirrors ai.RedisCache's miss contract:
// no entry, no error, just (nil, false).
func TestRedisCache_Get_MissReturnsFalse(t *testing.T) {
	cache, _ := newTestRedisCache(t)
	got, ok := cache.Get(context.Background(), "never-set")
	assert.False(t, ok)
	assert.Nil(t, got)
}

// TestRedisCache_DeleteByUser_RemovesOnlyThatUsersEntries is the direct
// regression test for kora#314 review finding #1 at the RedisCache level
// (internal/server/router_test.go's TestDeletionCache_* tests cover the
// composition/wiring level with fakes — this is the one that proves the
// real SCAN-by-prefix implementation actually works against real key
// storage). A second user's entry in the SAME cache must survive
// untouched — DeleteByUser must never over-match by prefix.
func TestRedisCache_DeleteByUser_RemovesOnlyThatUsersEntries(t *testing.T) {
	cache, _ := newTestRedisCache(t)
	ctx := context.Background()
	victim := uuid.New()
	survivor := uuid.New()

	victimKey := ai.CacheKey("body_composition", victim, "hash-a")
	survivorKey := ai.CacheKey("body_composition", survivor, "hash-b")
	cache.Set(ctx, victimKey, Result{Reading: ai.BodyCompositionReading{WeightKg: ptrf(70)}})
	cache.Set(ctx, survivorKey, Result{Reading: ai.BodyCompositionReading{WeightKg: ptrf(80)}})

	require.NoError(t, cache.DeleteByUser(ctx, victim))

	_, ok := cache.Get(ctx, victimKey)
	assert.False(t, ok, "the victim's entry must be gone")
	_, ok = cache.Get(ctx, survivorKey)
	assert.True(t, ok, "a DIFFERENT user's entry must survive — DeleteByUser must not over-match by prefix")
}

// TestRedisCache_DeleteByUser_NoEntriesIsNotAnError mirrors ai.RedisCache's
// contract: deleting a user with nothing cached is a harmless no-op, not an
// error — the same "SCAN finds zero keys" outcome Get's miss path relies on.
func TestRedisCache_DeleteByUser_NoEntriesIsNotAnError(t *testing.T) {
	cache, _ := newTestRedisCache(t)
	require.NoError(t, cache.DeleteByUser(context.Background(), uuid.New()))
}

func TestNoCache_Contract(t *testing.T) {
	c := NoCache{}
	ctx := context.Background()

	got, ok := c.Get(ctx, "anything")
	assert.False(t, ok)
	assert.Nil(t, got)

	require.NotPanics(t, func() {
		c.Set(ctx, "anything", Result{Reading: ai.BodyCompositionReading{WeightKg: ptrf(70)}})
	})

	got, ok = c.Get(ctx, "anything")
	assert.False(t, ok, "NoCache.Set must be a true no-op — a subsequent Get must still miss")
	assert.Nil(t, got)

	assert.NoError(t, c.DeleteByUser(ctx, uuid.New()), "DeleteByUser on NoCache must be a no-op, never an error")
}
