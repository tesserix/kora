// Package ratelimit provides the API's first rate limiter. It exists for one
// endpoint: exact-match handle lookup, where an unlimited caller can walk the
// handle space offline and learn who uses a calorie tracker.
package ratelimit

import (
	"sync"
	"time"
)

// Window is a fixed-window counter held IN PROCESS, deliberately.
//
// The obvious alternative is Redis, and it is the wrong one here. Redis in this
// API is OPTIONAL: cmd/api/main.go falls back to ai.NoCache{} when REDIS_URL
// does not parse or the client will not connect, and every other consumer
// degrades to "no caching" without complaint. A Redis-backed limiter inherits
// that posture and fails OPEN -- silently, with no signal, at exactly the moment
// infrastructure is unhealthy. For the one control standing between exact-match
// lookup and enumeration, failing open is not an acceptable degradation.
//
// In process, the counter cannot fail open, and kora-api runs a single replica
// today so the limit is exact. If it is ever scaled out, the effective limit
// becomes limit x replicas -- which is a LOOSER limit, not a broken one, and a
// deliberate trade rather than a bug. Move to a shared store only alongside a
// decision about what happens when that store is down.
type Window struct {
	limit  int
	period time.Duration

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	count int
	start time.Time
}

func NewWindow(limit int, period time.Duration) *Window {
	return &Window{limit: limit, period: period, buckets: map[string]*bucket{}}
}

// Allow reports whether key may make one more call at now, and counts it if so.
// now is a parameter rather than time.Now() so the window's BOUNDARIES can be
// tested without sleeping.
func (w *Window) Allow(key string, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.evictLocked(now)

	b, ok := w.buckets[key]
	if !ok || now.Sub(b.start) >= w.period {
		w.buckets[key] = &bucket{count: 1, start: now}
		return true
	}
	if b.count >= w.limit {
		return false
	}
	b.count++
	return true
}

// Size reports how many keys are held. Exported for the eviction test: without
// it, "the map does not grow forever" is not observable from outside.
func (w *Window) Size() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.buckets)
}

// evictLocked drops every bucket whose window has closed. Keys are user ids
// from authenticated requests, so this map's growth is bounded by active users
// rather than by an attacker -- but an unbounded map that is only ever added to
// is a leak regardless of who fills it, and the sweep is cheap at this scale.
func (w *Window) evictLocked(now time.Time) {
	for k, b := range w.buckets {
		if now.Sub(b.start) >= w.period {
			delete(w.buckets, k)
		}
	}
}
