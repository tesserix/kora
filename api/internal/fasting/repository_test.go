package fasting

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
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

// pgTooManyConnections is SQLSTATE 53300, "sorry, too many clients already".
const pgTooManyConnections = "53300"

// skipIfPostgresSaturated turns connection exhaustion into a skip.
//
// 53300 means the SERVER ran out of connection slots — it says nothing about
// the code under test. testDB above already takes exactly this posture for a
// database it cannot reach at all, and a saturated server is the same
// condition arriving a moment later.
//
// It matters here because TestStartHandlesGenuineConcurrentStarts needs TEN
// simultaneous connections by construction. Under `go test ./...` every
// package opens its own unbounded pool against the same local Postgres
// (max_connections defaults to 100), so the suite can exhaust the server
// while any single package passes comfortably on its own. That is why this
// test failed roughly once per full run and never in isolation, and why it
// reported "a concurrent start must never surface as an error" for a reason
// that had nothing to do with concurrent starts.
//
// Deliberately narrow: ONLY 53300 skips. Every other error still fails, so a
// genuine race regression cannot hide behind this.
func skipIfPostgresSaturated(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgTooManyConnections {
		t.Skipf("postgres is out of connection slots (SQLSTATE %s); this test needs several "+
			"simultaneous connections and cannot run against a saturated server. "+
			"Run this package on its own, or raise max_connections.", pgTooManyConnections)
	}
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
		db.Exec("DELETE FROM food_logs WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestStartIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db, nil)
	now := time.Now()

	first, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	// A double-tap, or a client retry, must not 400 and must not open a second.
	second, err := repo.Start(context.Background(), userID, now.Add(time.Minute), now)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID, "starting twice returns the SAME open fast")
}

// TestASecondOpenFastIsRejectedButASecondClosedFastIsFine covers both halves
// of "one open fast per user". The rejection half is Start's own idempotency
// (see TestStartIsIdempotent and TestStartHandlesGenuineConcurrentStarts);
// it is no longer the partial unique index, which kora#407's read-time
// openness fix had to drop -- see migration 000053.
func TestASecondOpenFastIsRejectedButASecondClosedFastIsFine(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db, nil)
	now := time.Now()

	first, err := repo.Start(context.Background(), userID, now.Add(-4*time.Hour), now)
	require.NoError(t, err)
	_, ended, err := repo.End(context.Background(), userID, now.Add(-time.Hour))
	require.NoError(t, err)
	require.True(t, ended)

	// Once the first is closed, a second may open -- and it is a genuinely
	// NEW interval, not the old one handed back.
	second, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err, "a user must be able to fast more than once")
	require.NotEqual(t, first.ID, second.ID, "the closed fast must not be resurrected")
}

func TestEndReportsWhenThereWasNothingOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db, nil)

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
	repo := NewRepository(db, nil)
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
	repo := NewRepository(db, nil)
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

// TestStartHandlesGenuineConcurrentStarts fires many goroutines at Start for
// the SAME user and asserts every one comes back with the SAME interval ID,
// with no error, leaving exactly one row -- the double-tap/retry idempotency
// contract, under genuine concurrency.
//
// The serialisation being exercised is Start's per-user advisory lock. It
// used to be the partial unique index fasting_intervals_one_open rejecting
// the loser with SQLSTATE 23505, which Start recovered from by re-reading;
// kora#407 had to drop that index (a fast ended by eating stays physically
// open forever, so the index rejected every genuine NEXT fast). The guarantee
// asserted here is unchanged; only the mechanism moved.
//
// Overlap is forced DETERMINISTICALLY, not hoped for. A bare goroutine race
// against a fast local Postgres round-trip was tried first and was flaky in
// exactly the direction the coordinator warned about: in 4 of 5 runs the
// goroutines never actually overlapped, each Start completing before the next
// one began, and the test passed without exercising anything.
// startRaceHook (test-only, nil in production) is used here as a barrier:
// every goroutine blocks in it until ALL n have arrived, so they are released
// into the transaction together and must contend for the lock.
//
// arrived == n after the run is the proof that happened, replacing the old
// "gorm logged a 23505" proof: it asserts every goroutine was inside Start,
// before any insert, at the same moment. Without it this test could silently
// degrade back into testing nothing the way the unbarriered version did.
//
// The hook fires BEFORE the transaction opens, not inside it: a barrier that
// waited for all n while one goroutine held the advisory lock would deadlock.
func TestStartHandlesGenuineConcurrentStarts(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	repo := NewRepository(db, nil)
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
		skipIfPostgresSaturated(t, errs[i])
		require.NoError(t, errs[i], "a concurrent start must never surface as an error")
		require.Equal(t, first.ID, results[i].ID, "every concurrent starter must get back the SAME open fast")
	}

	barrierMu.Lock()
	reachedBarrier := arrived
	barrierMu.Unlock()
	require.Equal(t, n, reachedBarrier,
		"not every goroutine reached the barrier -- the overlap was not forced, "+
			"so this run did not exercise the race this test exists to check")

	var count int64
	require.NoError(t, db.Model(&Interval{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Equal(t, int64(1), count, "the race must leave exactly one row, never one per goroutine")
}

// testDBWithMaxOpenConns is testDB with a deliberately tiny pool.
//
// The default testDB pool is unbounded, which is why the existing concurrency
// test could never have caught kora#413: with unlimited connections, a Start
// that needs two of them at once simply takes two.
func testDBWithMaxOpenConns(t *testing.T, n int) *gorm.DB {
	t.Helper()
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(n)
	return db
}

// TestStartDoesNotNeedASecondConnection is the regression test for kora#413.
//
// Start opens a transaction -- one connection -- and then calls Open, which
// asks FirstLogSource whether the user has eaten since the fast began. While
// that source was bound to the POOL rather than to the transaction, every
// Start held one connection and then blocked waiting for a second. With
// maxOpenConns = 5 in production, five concurrent starts deadlocked the whole
// API, not just fasting: every endpoint shares that pool.
//
// Both halves of the setup are load-bearing, and the reason #413 shipped is
// that TestStartHandlesGenuineConcurrentStarts has neither:
//
//   - a NON-NIL firstLogs, so the nested read actually happens. That test
//     passes nil, so the very path it exists to stress never runs.
//   - a pool small enough to exhaust. testDB sets no limit, so even a non-nil
//     source would just take a second connection and pass.
//
// A fast is opened BEFORE the concurrent run on purpose. Open only consults
// firstLogs once it has found a physically-open row, so starts against a user
// with no fast return early and never reach the nested read. Pre-seeding puts
// every goroutine on the two-connection path.
//
// n == maxOpenConns == 2 is then a deterministic deadlock under the bug: both
// goroutines check out a connection for their transaction, one takes the
// per-user advisory lock, and its nested read waits for a third connection
// that cannot exist. The context deadline is what turns that hang into a
// failed assertion instead of a test that never returns.
func TestStartDoesNotNeedASecondConnection(t *testing.T) {
	const conns = 2
	db := testDBWithMaxOpenConns(t, conns)
	userID := seedUser(t, db)

	// The real reader, not a double: the bug is about which handle the read
	// runs on, and a fake that touches no database cannot express that.
	repo := NewRepository(db, foodlog.NewRepository(db))
	now := time.Now()

	seed, err := repo.Start(context.Background(), userID, now.Add(-time.Hour), now)
	require.NoError(t, err)

	const n = conns
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

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	results := make([]Interval, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = repo.Start(ctx, userID, now, now)
		}()
	}
	wg.Wait()

	for i := 0; i < n; i++ {
		require.NoError(t, errs[i],
			"a start must not wait on a connection it is itself holding -- "+
				"with the pool exhausted this is the kora#413 deadlock")
		require.Equal(t, seed.ID, results[i].ID, "every starter must get back the open fast")
	}

	barrierMu.Lock()
	reachedBarrier := arrived
	barrierMu.Unlock()
	require.Equal(t, n, reachedBarrier,
		"not every goroutine reached the barrier -- the overlap was not forced, "+
			"so this run did not exercise the contention this test exists to check")

	var count int64
	require.NoError(t, db.Model(&Interval{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Equal(t, int64(1), count, "the run must leave exactly one row")
}
