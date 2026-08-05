package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Cache stores resolutions keyed by a stable, normalized cache key. A miss
// (not cached, cache unavailable, or a decode failure) is reported via the
// boolean return — implementations must NEVER treat a cache problem as a
// fatal error, since resolution must work with or without a cache.
//
// Delete removes one cached entry. It exists so a correction (foodlog.Service
// teaching or retracting a food_aliases row) can evict the stale Resolution
// that was cached BEFORE the correction — without it, a corrected phrase
// keeps serving the old, wrong resolution out of cache until the entry's TTL
// expires. Like Get/Set, a Delete failure must never be treated as fatal by
// callers; implementations report it via the error return so callers can log
// it, but callers must still proceed (best-effort, same as Set).
type Cache interface {
	Get(ctx context.Context, key string) (*Resolution, bool)
	Set(ctx context.Context, key string, r Resolution)
	Delete(ctx context.Context, key string) error
}

// Generation is the cache's invalidation-epoch surface, kept as its own
// small interface separate from Cache (rather than folded into it) so a
// caller that only needs to invalidate everything at once — the admin food
// mutation path — never has to depend on Get/Set/Delete, and so NoCache's
// generation methods can be trivial, silent no-ops with nothing to keep in
// sync.
//
// Bumping the generation invalidates every cache entry that could reference
// a given food's macros in one O(1), atomic operation, with no scan and no
// reverse index from food id back to cache keys. Cache keys are built from
// (kind, user, phrase/hash) — see CacheKey — and structurally carry no food
// id, so there is nothing to look up "every entry that might reference food
// X" against directly; the generation counter sidesteps needing one.
type Generation interface {
	// CurrentGeneration reports the cache's current invalidation
	// generation. A read failure is reported via the error return (rather
	// than folded into a zero value) so a caller — including a mutation's
	// own test — can distinguish "read failed" from "read succeeded and
	// returned 0", which is also the real baseline generation before any
	// bump has ever happened.
	CurrentGeneration(ctx context.Context) (int64, error)

	// BumpGeneration atomically increments the generation. Every cache
	// entry written before the bump becomes permanently unreachable via Get
	// from this point on. Bumping does not delete anything — entries simply
	// age out on their own TTL, the same as any other miss.
	BumpGeneration(ctx context.Context) error
}

// NoCache is a no-op Cache used when caching is disabled or unconfigured. It
// also satisfies Generation trivially: there is no real cache to invalidate,
// so CurrentGeneration is a fixed, meaningless 0 and BumpGeneration is a
// silent no-op — callers on the admin mutation path never need to
// special-case "caching is off".
type NoCache struct{}

var (
	_ Cache      = NoCache{}
	_ Generation = NoCache{}
)

// Get always misses.
func (NoCache) Get(ctx context.Context, key string) (*Resolution, bool) {
	return nil, false
}

// Set is a no-op.
func (NoCache) Set(ctx context.Context, key string, r Resolution) {}

// Delete is a no-op — there is nothing to evict when caching is disabled.
func (NoCache) Delete(ctx context.Context, key string) error {
	return nil
}

// CurrentGeneration always reports the baseline 0 — there is no real counter
// to read.
func (NoCache) CurrentGeneration(ctx context.Context) (int64, error) {
	return 0, nil
}

// BumpGeneration is a no-op — there is nothing to invalidate.
func (NoCache) BumpGeneration(ctx context.Context) error {
	return nil
}

// resolveCacheGenerationKey is the single Redis key holding the resolve
// cache's invalidation generation counter. It is process-wide (not scoped by
// kind or user) because a food's macros can be embedded in a cached
// Resolution under any kind (phrase, photo, voice) and any user's key —
// bumping this one counter invalidates all of them at once, which is the
// entire point.
//
// OPS PRECONDITION: whoever configures the Redis instance this cache runs
// against MUST set maxmemory-policy to a TTL-respecting eviction policy
// (e.g. volatile-lru or noeviction) — NOT allkeys-lru or allkeys-random. This
// key is deliberately persistent (no TTL; INCR attaches none), so under
// allkeys-lru/allkeys-random Redis is free to evict it under memory pressure
// exactly like any other key, even though it never expires. RedisCache's
// high-water-mark guard (see generationHWM) closes the resulting hole —
// treating a post-eviction re-read as a failure rather than silently
// resetting to the pre-bump baseline — but that guard is a safety net for a
// misconfiguration, not a substitute for configuring the policy correctly.
const resolveCacheGenerationKey = "ai:resolve-cache:generation"

// RedisCache is a Cache backed by Redis, storing resolutions as JSON with a
// fixed TTL. Any Redis or (de)serialization failure is treated as a miss on
// Get, or silently dropped on Set — a cache problem must never break a
// resolve request. It also satisfies Generation: every physical Redis key it
// reads or writes is scoped by the current generation (see
// generationScopedKey), so RedisCache.BumpGeneration makes every previously
// written entry unreachable in one atomic INCR, with no scan.
type RedisCache struct {
	client *redis.Client
	ttl    time.Duration

	// generationHWM is a process-local high-water mark: the highest
	// generation this RedisCache has ever observed from Redis. It exists
	// to close a hole that a bare read of resolveCacheGenerationKey cannot
	// close on its own — see readGeneration.
	generationHWM atomic.Int64
}

var (
	_ Cache      = (*RedisCache)(nil)
	_ Generation = (*RedisCache)(nil)
)

// NewRedisCache builds a RedisCache over an existing client with the given
// entry TTL.
func NewRedisCache(client *redis.Client, ttl time.Duration) *RedisCache {
	return &RedisCache{client: client, ttl: ttl}
}

// readGeneration is the single place RedisCache reads the invalidation
// generation from Redis. A missing key (redis.Nil) is the normal baseline —
// this cache has never been bumped yet — and reports generation 0 with no
// error. Any other error (most importantly: Redis unreachable, which is
// production's current state today — REDIS_URL is unset, so buildResolveHandler
// falls back to NoCache at startup, but this path matters for Redis dying
// AFTER startup, once it's actually wired) is returned as-is.
//
// Get/Set/Delete below all make the same choice about what a failed read
// means: treat the cache as absent for that one call, rather than falling
// back to a fixed generation number. A fixed fallback was rejected because it
// can collide: generation 0 is not a made-up placeholder, it is the real,
// valid generation every entry was written under before the very first bump
// ever happens — so a fixed fallback of 0 would silently serve back a
// pre-bump entry the instant it is still physically present (before its TTL
// expires), which is exactly the cross-generation collision this whole
// mechanism exists to prevent. Treating the cache as absent instead costs
// nothing but the cache hit that would have happened anyway — a cache is a
// cost optimisation here, never a correctness mechanism, so a guaranteed miss
// is always an acceptable degradation and an occasional stale hit is not.
//
// A "missing key" read alone is not enough to tell a legitimate un-bumped
// baseline apart from resolveCacheGenerationKey having been EVICTED after a
// real bump already happened — Redis reports both as redis.Nil identically,
// and the key is deliberately persistent (see its doc comment on
// maxmemory-policy) so this is not a TTL expiry, only an eviction. To tell
// them apart, readGeneration keeps a process-local high-water mark
// (generationHWM) of the highest generation it has ever actually observed:
// any newly read generation LOWER than that high-water mark — including the
// re-synthesized 0 from a re-missing key — is treated as a read FAILURE, the
// same as any other Redis error, rather than as a valid (if stale) value.
// This also incidentally guards against a Redis replica serving a
// lagging/stale counter value. generationHWM is read and updated with a
// compare-and-swap loop so concurrent callers on the hot resolve path never
// serialize behind a lock for this check.
func (c *RedisCache) readGeneration(ctx context.Context) (int64, error) {
	n, err := c.client.Get(ctx, resolveCacheGenerationKey).Int64()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			return 0, err
		}
		n = 0
	}

	for {
		hwm := c.generationHWM.Load()
		if n < hwm {
			return 0, fmt.Errorf("ai: observed generation %d below high-water mark %d (counter key evicted or stale replica read)", n, hwm)
		}
		if n == hwm {
			return n, nil
		}
		if c.generationHWM.CompareAndSwap(hwm, n) {
			return n, nil
		}
		// Lost the race to another goroutine observing a newer generation
		// concurrently; retry against the updated high-water mark.
	}
}

// generationScopedKey combines a logical cache key (see CacheKey) with the
// generation it was built under into the physical key actually stored in
// Redis. CacheKey itself stays generation-agnostic — normalization and
// per-user scoping are a property of the DATA (which phrase, whose alias
// table), while the generation is a property of the CACHE'S LIFECYCLE (which
// epoch is currently valid) — so every existing CacheKey caller keeps
// working unchanged; only RedisCache needs to know generations exist at all.
func generationScopedKey(key string, generation int64) string {
	return key + ":g" + strconv.FormatInt(generation, 10)
}

// Get fetches and decodes a cached Resolution. Any error (miss, Redis down,
// bad JSON, or a failed generation read — see readGeneration) results in
// (nil, false) — never an error, never a panic.
func (c *RedisCache) Get(ctx context.Context, key string) (*Resolution, bool) {
	generation, err := c.readGeneration(ctx)
	if err != nil {
		return nil, false
	}

	data, err := c.client.Get(ctx, generationScopedKey(key, generation)).Bytes()
	if err != nil {
		return nil, false
	}

	var r Resolution
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, false
	}

	return &r, true
}

// Set marshals and stores a Resolution with the cache's TTL, under the
// current generation. Failures — including a failed generation read — are
// swallowed (best-effort): a cache write must never break a resolve. A
// failed generation read specifically skips the write entirely rather than
// writing under a guessed generation, for the same collision reason
// documented on readGeneration.
func (c *RedisCache) Set(ctx context.Context, key string, r Resolution) {
	generation, err := c.readGeneration(ctx)
	if err != nil {
		return
	}

	data, err := json.Marshal(r)
	if err != nil {
		return
	}

	_ = c.client.Set(ctx, generationScopedKey(key, generation), data, c.ttl).Err()
}

// Delete evicts one cached entry, scoped by the SAME generation Get/Set
// would currently use. This is correct for its one real caller
// (foodlog.Service's correction-invalidation, which deletes shortly after
// the entry could have been cached, with no bump in between): the physical
// key it computes matches the one Set would have written. If a generation
// bump DID happen in between, the entry Delete is trying to reach is already
// unreachable via Get regardless, so this becomes a harmless no-op — deleting
// a key that isn't there (already expired, never set, or already orphaned by
// a bump) is not an error; Redis's DEL simply reports it deleted zero keys.
//
// A failed generation read IS reported as an error here (unlike Get/Set,
// which swallow it), so it surfaces through the one caller that already logs
// Delete errors — but exactly like every other Cache failure, it must never
// be treated as fatal by that caller.
func (c *RedisCache) Delete(ctx context.Context, key string) error {
	generation, err := c.readGeneration(ctx)
	if err != nil {
		return err
	}
	return c.client.Del(ctx, generationScopedKey(key, generation)).Err()
}

// CurrentGeneration reports the generation Get/Set/Delete are currently
// scoping their physical keys by, or the error that made a fresh read fail.
func (c *RedisCache) CurrentGeneration(ctx context.Context) (int64, error) {
	return c.readGeneration(ctx)
}

// BumpGeneration atomically increments the generation counter. Redis's INCR
// is atomic and self-initializing (a missing key is treated as 0 before
// incrementing), so this needs no read-modify-write, and no prior
// BumpGeneration call ever has to have happened.
func (c *RedisCache) BumpGeneration(ctx context.Context) error {
	return c.client.Incr(ctx, resolveCacheGenerationKey).Err()
}

// CacheKey builds a stable, normalized cache key from a kind
// ("barcode"|"phrase"|"photo"|"voice"), the requesting user's id, and a
// value.
//
// userID is part of the key because resolution is user-dependent:
// nutrition.Repository.Resolve checks the requesting user's personal
// food_aliases before curated/global ones (see nutrition/alias.go), so the
// same phrase can legitimately resolve to different food items for
// different users. A key that omitted the user id would let one user's
// personal-alias correction populate a shared cache entry that every other
// user's identical phrase/photo/voice request then reads back — silently
// serving that user's correction (and its nutrition numbers) to strangers.
// There is deliberately no unscoped variant of this function.
func CacheKey(kind string, userID uuid.UUID, value string) string {
	return kind + ":" + userID.String() + ":" + strings.ToLower(strings.TrimSpace(value))
}
