package agents

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// CacheResult labels how a resolution was served, for metrics and for the
// caller's own logging. Stale is the interesting one: it means the registry
// failed and the last good copy was served instead.
type CacheResult string

const (
	CacheHit   CacheResult = "hit"
	CacheMiss  CacheResult = "miss"
	CacheStale CacheResult = "stale"
	CacheError CacheResult = "error"
)

// entry is one cached resolution plus the instant it goes stale. The value is
// kept after expiry so a registry outage can be served from it.
type entry struct {
	value     *ResolvedAgent
	expiresAt time.Time
}

// cache is a TTL map with single-flight loading and stale-on-error fallback.
//
// Single-flight matters here because every coach request resolves the same
// agent: without it, a cold cache under load would fan every concurrent
// request out to the registry at once.
type cache struct {
	ttl   time.Duration
	group singleflight.Group

	mu      sync.RWMutex
	entries map[string]entry

	now func() time.Time
}

func newCache(ttl time.Duration) *cache {
	return &cache{ttl: ttl, entries: map[string]entry{}, now: time.Now}
}

// load returns the cached value for key, calling fetch only when the entry is
// missing or expired. If fetch fails but a stale entry exists, the stale value
// is returned with CacheStale and no error — a registry outage must not take
// the coach down with it.
func (c *cache) load(ctx context.Context, key string, fetch func(context.Context) (*ResolvedAgent, error)) (*ResolvedAgent, CacheResult, error) {
	if v, ok := c.fresh(key); ok {
		return v, CacheHit, nil
	}

	type loaded struct {
		value  *ResolvedAgent
		result CacheResult
	}

	out, err, _ := c.group.Do(key, func() (any, error) {
		// Re-check inside the flight: the winner of a concurrent race may
		// already have filled the entry while this call was queued.
		if v, ok := c.fresh(key); ok {
			return loaded{value: v, result: CacheHit}, nil
		}

		value, err := fetch(ctx)
		if err != nil {
			if stale, ok := c.stale(key); ok {
				return loaded{value: stale, result: CacheStale}, nil
			}
			return nil, err
		}

		c.store(key, value)
		return loaded{value: value, result: CacheMiss}, nil
	})
	if err != nil {
		return nil, CacheError, err
	}

	l := out.(loaded)
	return l.value, l.result, nil
}

// invalidate drops a key so the next load re-fetches it. Used by the refresh
// endpoint when a new agent revision is published.
func (c *cache) invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

func (c *cache) fresh(key string) (*ResolvedAgent, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || !c.now().Before(e.expiresAt) {
		return nil, false
	}
	return e.value, true
}

func (c *cache) stale(key string) (*ResolvedAgent, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	return e.value, ok && e.value != nil
}

func (c *cache) store(key string, value *ResolvedAgent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = entry{value: value, expiresAt: c.now().Add(c.ttl)}
}

// cacheKey identifies one agent revision. An empty tag means "whatever the
// registry currently calls latest", which is a different cache line from an
// explicitly pinned tag.
func cacheKey(name, tag string) string {
	if tag == "" {
		return name
	}
	return name + "@" + tag
}

// pathOf extracts the path from a card's A2A URL, tolerating a bare path. The
// host is deliberately discarded — see ResolvedAgent.A2APath.
func pathOf(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		return "/" + strings.TrimPrefix(raw, "/")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Path
}
