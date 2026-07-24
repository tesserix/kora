package ai

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache stores resolutions keyed by a stable, normalized cache key. A miss
// (not cached, cache unavailable, or a decode failure) is reported via the
// boolean return — implementations must NEVER treat a cache problem as a
// fatal error, since resolution must work with or without a cache.
type Cache interface {
	Get(ctx context.Context, key string) (*Resolution, bool)
	Set(ctx context.Context, key string, r Resolution)
}

// NoCache is a no-op Cache used when caching is disabled or unconfigured.
type NoCache struct{}

// Get always misses.
func (NoCache) Get(ctx context.Context, key string) (*Resolution, bool) {
	return nil, false
}

// Set is a no-op.
func (NoCache) Set(ctx context.Context, key string, r Resolution) {}

// RedisCache is a Cache backed by Redis, storing resolutions as JSON with a
// fixed TTL. Any Redis or (de)serialization failure is treated as a miss on
// Get, or silently dropped on Set — a cache problem must never break a
// resolve request.
type RedisCache struct {
	client *redis.Client
	ttl    time.Duration
}

// NewRedisCache builds a RedisCache over an existing client with the given
// entry TTL.
func NewRedisCache(client *redis.Client, ttl time.Duration) *RedisCache {
	return &RedisCache{client: client, ttl: ttl}
}

// Get fetches and decodes a cached Resolution. Any error (miss, Redis down,
// bad JSON) results in (nil, false) — never an error, never a panic.
func (c *RedisCache) Get(ctx context.Context, key string) (*Resolution, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		return nil, false
	}

	var r Resolution
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, false
	}

	return &r, true
}

// Set marshals and stores a Resolution with the cache's TTL. Failures are
// swallowed (best-effort) — a cache write must never break a resolve.
func (c *RedisCache) Set(ctx context.Context, key string, r Resolution) {
	data, err := json.Marshal(r)
	if err != nil {
		return
	}

	_ = c.client.Set(ctx, key, data, c.ttl).Err()
}

// CacheKey builds a stable, normalized cache key from a kind
// ("barcode"|"phrase"|"photo") and a value.
func CacheKey(kind, value string) string {
	return kind + ":" + strings.ToLower(strings.TrimSpace(value))
}
