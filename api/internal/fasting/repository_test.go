package fasting

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedUser inserts a bare user row and returns its id.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "fa-"+id.String(), "fa@test.dev").Error)
	t.Cleanup(func() {
		// Scoped to this test's own user, never a truncate -- these tests own
		// their fixtures and must not disturb anyone else's rows (kora#151).
		db.Exec("DELETE FROM fasting_intervals WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestStartIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	first, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	// A double-tap, or a client retry, must not 400 and must not open a second.
	second, err := repo.Start(context.Background(), userID, now.Add(time.Minute), now)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID, "starting twice returns the SAME open fast")
}

func TestASecondOpenFastIsRejectedButASecondClosedFastIsFine(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	_, err := repo.Start(context.Background(), userID, now.Add(-4*time.Hour), now)
	require.NoError(t, err)
	_, ended, err := repo.End(context.Background(), userID, now.Add(-time.Hour))
	require.NoError(t, err)
	require.True(t, ended)

	// The index is PARTIAL: once the first is closed, a second may open.
	// A non-partial unique index on (user_id) would reject this.
	_, err = repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err, "a user must be able to fast more than once")
}

func TestEndReportsWhenThereWasNothingOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, ended, err := repo.End(context.Background(), userID, time.Now())
	require.NoError(t, err, "ending nothing is not an error, just a no-op")
	require.False(t, ended)
}

// TestEndSetsEndedAtAndEndedByTogether guards the finding carried from Task
// 1's review: the table's CHECK constraints validate ended_at > started_at
// and ended_by = 'user' independently, but not as a pair. Repository.End is
// the only write path for either, so it must never leave one set without
// the other.
func TestEndSetsEndedAtAndEndedByTogether(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	_, err := repo.Start(context.Background(), userID, now.Add(-time.Hour), now)
	require.NoError(t, err)

	ended, ok, err := repo.End(context.Background(), userID, now)
	require.NoError(t, err)
	require.True(t, ok)
	require.NotNil(t, ended.EndedAt)
	require.NotNil(t, ended.EndedBy)
	require.Equal(t, EndedByUser, *ended.EndedBy)

	var stored Interval
	require.NoError(t, db.Where("id = ?", ended.ID).First(&stored).Error)
	require.NotNil(t, stored.EndedAt)
	require.NotNil(t, stored.EndedBy)
	require.Equal(t, EndedByUser, *stored.EndedBy)
}

func TestSinceReturnsOpenAndRecentlyClosedIntervals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	// Closed well before the window: excluded.
	old, err := repo.Start(context.Background(), userID, now.Add(-72*time.Hour), now)
	require.NoError(t, err)
	require.NoError(t, db.Model(&Interval{}).Where("id = ?", old.ID).
		Updates(map[string]any{"ended_at": now.Add(-70 * time.Hour), "ended_by": EndedByUser}).Error)

	// Closed inside the window: included.
	recent, err := repo.Start(context.Background(), userID, now.Add(-30*time.Hour), now)
	require.NoError(t, err)
	require.NoError(t, db.Model(&Interval{}).Where("id = ?", recent.ID).
		Updates(map[string]any{"ended_at": now.Add(-1 * time.Hour), "ended_by": EndedByUser}).Error)

	// Still open: included regardless of when it started.
	open, err := repo.Start(context.Background(), userID, now.Add(-2*time.Hour), now)
	require.NoError(t, err)

	out, err := repo.Since(context.Background(), userID, now.Add(-24*time.Hour))
	require.NoError(t, err)

	ids := make(map[uuid.UUID]bool, len(out))
	for _, in := range out {
		ids[in.ID] = true
	}
	require.False(t, ids[old.ID], "closed well before the window must be excluded")
	require.True(t, ids[recent.ID], "closed inside the window must be included")
	require.True(t, ids[open.ID], "still-open must be included regardless of start")
}

// raceLogWriter captures gorm's Error-level SQL trace lines so the
// concurrency test below can prove -- not just hope -- that the 23505 path
// in Start was actually exercised.
type raceLogWriter struct {
	mu      sync.Mutex
	sawRace bool
}

func (w *raceLogWriter) Printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	if strings.Contains(line, "23505") || strings.Contains(line, "duplicate key") {
		w.mu.Lock()
		w.sawRace = true
		w.mu.Unlock()
	}
}

func (w *raceLogWriter) raceObserved() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sawRace
}

// TestStartHandlesGenuineConcurrentStarts fires many goroutines at Start for
// the SAME user and asserts every one comes back with the SAME interval ID
// and no error -- the concurrent-start race the partial unique index
// (fasting_intervals_one_open) turns into a 23505 that Start must recover
// from by re-reading Open(), not surface as a 500.
//
// Overlap is forced DETERMINISTICALLY, not hoped for. A bare goroutine race
// against a fast local Postgres round-trip was tried first and was flaky in
// exactly the direction the coordinator warned about: in 4 of 5 runs, no
// goroutine ever logged a 23505 at all, because each Start's Open-then-Create
// pair completed before the next one's Open ran -- the goroutines never
// actually overlapped, and the test passed without exercising anything.
// startRaceHook (test-only, nil in production) is used here as a barrier:
// every goroutine calls Open(), finds nothing, and then blocks in the hook
// until ALL n goroutines have reached that same point, so they are released
// to attempt the INSERT together. n-1 of them are guaranteed to collide on
// fasting_intervals_one_open and take the 23505 recovery path.
//
// writer.raceObserved() is the proof this actually happened: it asserts
// gorm logged at least one 23505/duplicate-key trace, so this test cannot
// silently degrade back into testing nothing the way the unbarriered
// version did.
func TestStartHandlesGenuineConcurrentStarts(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	writer := &raceLogWriter{}
	tracedDB := db.Session(&gorm.Session{
		Logger: gormlogger.New(writer, gormlogger.Config{LogLevel: gormlogger.Error}),
	})
	repo := NewRepository(tracedDB)
	now := time.Now()

	const n = 10
	var barrierMu sync.Mutex
	arrived := 0
	release := make(chan struct{})
	startRaceHook = func() {
		barrierMu.Lock()
		arrived++
		reached := arrived == n
		barrierMu.Unlock()
		if reached {
			close(release)
		}
		<-release
	}
	t.Cleanup(func() { startRaceHook = nil })

	var wg sync.WaitGroup
	results := make([]Interval, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			in, err := repo.Start(context.Background(), userID, now, now)
			results[i] = in
			errs[i] = err
		}()
	}
	wg.Wait()

	first := results[0]
	for i := 0; i < n; i++ {
		require.NoError(t, errs[i], "a concurrent start must never surface as an error")
		require.Equal(t, first.ID, results[i].ID, "every concurrent starter must get back the SAME open fast")
	}

	require.True(t, writer.raceObserved(),
		"no 23505 was logged by any goroutine -- the barrier failed to force a genuine overlap, "+
			"so this run did not exercise the race this test exists to check")

	var count int64
	require.NoError(t, db.Model(&Interval{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Equal(t, int64(1), count, "the race must leave exactly one row, never one per goroutine")
}
