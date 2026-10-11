package ratelimit

import (
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var t0 = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

func TestWindow_AllowsUpToTheLimitThenRefuses(t *testing.T) {
	w := NewWindow(3, time.Minute)
	for i := 0; i < 3; i++ {
		require.True(t, w.Allow("u1", t0), "call %d must be allowed", i+1)
	}
	require.False(t, w.Allow("u1", t0), "the call past the limit must be refused")
}

func TestWindow_KeysAreIndependent(t *testing.T) {
	w := NewWindow(1, time.Minute)
	require.True(t, w.Allow("u1", t0))
	require.False(t, w.Allow("u1", t0))
	require.True(t, w.Allow("u2", t0), "one user's limit must not spend another's")
}

// Both bounds. A test that only proves the window reopens after a long wait
// would pass against an implementation with no window at all.
func TestWindow_ResetsOnlyAfterThePeriod(t *testing.T) {
	w := NewWindow(1, time.Minute)
	require.True(t, w.Allow("u1", t0))
	require.False(t, w.Allow("u1", t0.Add(59*time.Second)), "still inside the window")
	require.True(t, w.Allow("u1", t0.Add(61*time.Second)), "past the window")
}

func TestWindow_IsSafeUnderConcurrency(t *testing.T) {
	w := NewWindow(100, time.Minute)
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w.Allow("shared", t0) {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	require.Equal(t, 100, allowed, "exactly the limit, no more and no fewer")
}

// The map must not grow without bound: every distinct key is a heap entry, and
// keys are user ids supplied by whoever is calling.
func TestWindow_EvictsStaleKeys(t *testing.T) {
	w := NewWindow(1, time.Minute)
	for i := 0; i < 500; i++ {
		w.Allow("u"+strconv.Itoa(i), t0)
	}
	w.Allow("fresh", t0.Add(2*time.Minute))
	require.LessOrEqual(t, w.Size(), 1,
		"keys whose window has closed must be dropped, not kept forever")
}
