package bodyread

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Cache stores a body-composition Result keyed by a stable cache key (see
// CacheKey in service.go). This is a package-local interface rather than a
// reuse of ai.Cache: ai.Cache's Get/Set are hard-typed to ai.Resolution
// (checked directly against internal/ai/cache.go before writing this file),
// so a Result — a completely different shape, with no Resolution anywhere
// in it — cannot be pushed through that interface. RedisCache below is a
// second, PURPOSELY MINIMAL concrete cache, not a divergent reimplementation
// of ai.RedisCache's generation/invalidation machinery: body-composition
// readings reference no nutrition.FoodItem row, so there is nothing for an
// admin food-mutation to invalidate here, and the whole generation-epoch
// mechanism ai.RedisCache carries for that reason simply does not apply.
//
// Like ai.Cache, a cache problem here (Redis down, bad JSON) must NEVER be
// treated as fatal — Get reports it as a miss, Set silently drops the
// write.
//
// DeleteByUser exists for the SAME reason ai.Cache carries it: this cache
// holds a *resolution* derived from a health screenshot (weight, body fat,
// visceral fat, BMR — see Result), keyed by the user's uuid. That is
// exactly the kind of derived personal data account deletion has to
// remove, not leave sitting in Redis for up to the full TTL after the
// user's row is destroyed. `user.CacheEvicter` (internal/user/deletion.go)
// declares this same one-method shape independently — see
// internal/server/router.go's deletionCache, which fans DeleteByUser out to
// BOTH this cache and the resolve cache so Service.Delete evicts both.
type Cache interface {
	Get(ctx context.Context, key string) (*Result, bool)
	Set(ctx context.Context, key string, r Result)
	DeleteByUser(ctx context.Context, userID uuid.UUID) error
}

// NoCache is a no-op Cache, used when Redis is unconfigured or unreachable
// — mirrors ai.NoCache so an unavailable cache degrades the same way
// everywhere in this codebase: every read is a guaranteed miss, every write
// is a silent no-op, and Reader never has to special-case "caching is off".
// DeleteByUser is a no-op too — there is nothing to evict when caching is
// disabled, mirroring ai.NoCache.DeleteByUser exactly.
type NoCache struct{}

var _ Cache = NoCache{}

func (NoCache) Get(ctx context.Context, key string) (*Result, bool) { return nil, false }
func (NoCache) Set(ctx context.Context, key string, r Result)       {}
func (NoCache) DeleteByUser(ctx context.Context, userID uuid.UUID) error {
	return nil
}

// RedisCache is a Cache backed by Redis, storing Results as JSON with a
// fixed TTL. It deliberately shares the *redis.Client CONNECTION with
// ai.RedisCache (constructed alongside it in cmd/api/main.go's
// buildResolveHandler) rather than opening a second connection pool against
// the same Redis instance — but it is its own struct with its own key
// namespace (see CacheKey's "body_composition" kind in service.go), so it
// never collides with ai.RedisCache's keys or touches its invalidation
// generation counter.
type RedisCache struct {
	client *redis.Client
	ttl    time.Duration
}

var _ Cache = (*RedisCache)(nil)

// NewRedisCache builds a RedisCache over an existing client with the given
// entry TTL.
func NewRedisCache(client *redis.Client, ttl time.Duration) *RedisCache {
	return &RedisCache{client: client, ttl: ttl}
}

// Get fetches and decodes a cached Result. Any error (miss, Redis down, bad
// JSON) results in (nil, false) — never an error, never a panic.
func (c *RedisCache) Get(ctx context.Context, key string) (*Result, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		return nil, false
	}
	var r Result
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, false
	}
	return &r, true
}

// Set marshals and stores a Result with the cache's TTL. Failures are
// swallowed (best-effort): a cache write must never break a read.
func (c *RedisCache) Set(ctx context.Context, key string, r Result) {
	data, err := json.Marshal(r)
	if err != nil {
		return
	}
	_ = c.client.Set(ctx, key, data, c.ttl).Err()
}

// DeleteByUser sweeps every cached Result belonging to userID. Physical keys
// are "body_composition:<uuid>:<hash>" (see CacheKey in service.go) with NO
// generation suffix — this cache carries no generation/invalidation
// machinery at all (see the Cache doc comment), so unlike
// ai.RedisCache.DeleteByUser there is only one key shape to sweep, not one
// per generation epoch.
//
// SCAN, never KEYS: KEYS blocks the server for the whole sweep, exactly the
// reasoning ai.RedisCache.DeleteByUser documents for the same choice.
func (c *RedisCache) DeleteByUser(ctx context.Context, userID uuid.UUID) error {
	pattern := "body_composition:" + userID.String() + ":*"
	var cursor uint64
	for {
		keys, next, err := c.client.Scan(ctx, cursor, pattern, 256).Result()
		if err != nil {
			return fmt.Errorf("bodyread: scan %s: %w", pattern, err)
		}
		if len(keys) > 0 {
			if err := c.client.Del(ctx, keys...).Err(); err != nil {
				return fmt.Errorf("bodyread: delete %s: %w", pattern, err)
			}
		}
		if next == 0 {
			break
		}
		cursor = next
	}
	return nil
}
