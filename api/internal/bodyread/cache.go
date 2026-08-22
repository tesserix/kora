package bodyread

import (
	"context"
	"encoding/json"
	"time"

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
type Cache interface {
	Get(ctx context.Context, key string) (*Result, bool)
	Set(ctx context.Context, key string, r Result)
}

// NoCache is a no-op Cache, used when Redis is unconfigured or unreachable
// — mirrors ai.NoCache so an unavailable cache degrades the same way
// everywhere in this codebase: every read is a guaranteed miss, every write
// is a silent no-op, and Reader never has to special-case "caching is off".
type NoCache struct{}

var _ Cache = NoCache{}

func (NoCache) Get(ctx context.Context, key string) (*Result, bool) { return nil, false }
func (NoCache) Set(ctx context.Context, key string, r Result)       {}

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
