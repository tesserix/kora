package fasting

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// FirstLogSource reports the earliest food log strictly after `after`, or nil.
//
// A narrow injected port, mirroring how coach declares FastingSource and
// tracking declares SignalsSource. foodlog.Repository satisfies it.
//
// It exists because "is a fast open?" is a COMPUTED question (kora#407
// decision 2): ended_at is written only by an explicit end, so a fast ended
// by eating -- the ordinary case -- leaves its row physically open forever.
// Answering that question therefore needs the first food log after the fast
// began, which lives in foodlog.
//
// The dependency runs fasting -> foodlog. Decision 3 ruled out the OTHER
// direction (foodlog -> fasting, the write-hook shape that would have to
// hook Create's three call sites plus CreateIdempotent). This is not that.
//
// The read takes the *gorm.DB to run on rather than carrying its own handle
// (kora#413). Open passes the handle IT is reading the fast row through, so
// inside Start's transaction the food-log read runs on the transaction's
// connection. When the source held a pool-bound handle instead, every Start
// checked out one connection for its transaction and then blocked waiting for
// a second; maxOpenConns is 5, so five concurrent starts stalled every
// endpoint sharing the pool.
type FirstLogSource interface {
	FirstLogAfter(ctx context.Context, db *gorm.DB, userID uuid.UUID, after time.Time) (*time.Time, error)
}

// startRaceHook, when non-nil, is called by Start BEFORE it opens the
// transaction that serialises concurrent starts for the same user. It exists
// only so TestStartHandlesGenuineConcurrentStarts can force many goroutines
// to overlap deterministically inside that window -- a bare goroutine race
// against a fast local Postgres round-trip was observed to frequently NOT
// overlap at all (each Start completing before the next one's read ran),
// which would make that test pass without ever exercising the contended
// path. Production code never sets this; it is always nil there and this
// branch is then a no-op.
//
// It fires before the transaction, not inside it: a barrier that waits for
// all n goroutines while one of them holds the per-user advisory lock would
// deadlock, since the other n-1 could never reach it.
var startRaceHook func()

type Repository struct {
	db *gorm.DB
	// firstLogs answers "did the user eat after this fast began?". Required
	// in production -- see NewRepository.
	firstLogs FirstLogSource
}

// NewRepository wires the fasting store.
//
// firstLogs is a REQUIRED constructor argument rather than an optional
// builder on purpose. Without it, Open cannot see the food-log ending and
// reports a fast that a meal closed hours ago as still running -- which
// under-counts DeclaredFastHours and under-fires an eating-disorder
// guardrail. That is the dangerous direction, so the wiring must be
// impossible to forget rather than merely easy to remember. Passing nil is
// legal for tests that exercise paths where no food log exists, and means
// "the user has never logged".
func NewRepository(db *gorm.DB, firstLogs FirstLogSource) Repository {
	return Repository{db: db, firstLogs: firstLogs}
}

// withDB returns a copy of r bound to another *gorm.DB (a transaction),
// leaving the receiver untouched.
func (r Repository) withDB(db *gorm.DB) Repository {
	r.db = db
	return r
}

// advisoryLockKey derives a stable 64-bit Postgres advisory-lock key from a
// user id. The first 8 bytes of a v4 UUID are random, so keys spread evenly;
// a collision between two users only serialises two unrelated Starts for the
// duration of one INSERT, which is harmless.
//
// Computed in Go rather than with Postgres' hashtext/hashtextextended so this
// does not depend on an undocumented internal function.
func advisoryLockKey(userID uuid.UUID) int64 {
	return int64(binary.BigEndian.Uint64(userID[:8]))
}

// Start opens a fast, or returns the one already open.
//
// Idempotent on purpose: a double-tap and a client retry are the same request
// as far as the user is concerned, and a 400 for either would be a bug the
// user experiences as the button not working.
//
// The read-then-insert is serialised per user by a transaction-scoped
// advisory lock. It used to rely instead on a partial unique index
// (fasting_intervals_one_open) rejecting the loser of a concurrent start with
// SQLSTATE 23505, which Start recovered from by re-reading. That index could
// not survive kora#407's fix: once "open" became a COMPUTED question, a fast
// the user ended by eating stays physically open (ended_at IS NULL) forever,
// so the index rejected every genuine NEXT fast -- and the recovery re-read
// then found nothing open and surfaced a 500. Closing the stale row instead
// was rejected: that writes ended_at on a non-explicit path, which decision 2
// forbids. Postgres can no longer express the invariant, because the
// invariant is no longer a column, so the serialisation moved to the lock.
// The lock gives the same guarantee the index gave (n concurrent Starts leave
// exactly one row and all return it) without constraining rows the user has
// finished with.
func (r Repository) Start(ctx context.Context, userID uuid.UUID, now, localDate time.Time) (Interval, error) {
	if startRaceHook != nil {
		startRaceHook()
	}
	var out Interval
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockKey(userID)).Error; err != nil {
			return fmt.Errorf("lock: %w", err)
		}
		existing, ok, err := r.withDB(tx).Open(ctx, userID, now)
		if err != nil {
			return err
		}
		if ok {
			out = existing
			return nil
		}
		in := Interval{UserID: userID, StartedAt: now, LocalDate: localDate}
		if err := tx.Create(&in).Error; err != nil {
			return err
		}
		out = in
		return nil
	})
	if err != nil {
		return Interval{}, fmt.Errorf("fasting: start: %w", err)
	}
	return out, nil
}

// End closes the open fast. ok is false when there was nothing open, which is
// not an error -- the user tapped end on a screen that had gone stale, or on
// a fast that a meal or the cap had already ended.
//
// ended_at and ended_by are always written together: the table's CHECK
// constraints validate each independently but not as a pair, and this is the
// only write path that sets either.
func (r Repository) End(ctx context.Context, userID uuid.UUID, now time.Time) (Interval, bool, error) {
	open, ok, err := r.Open(ctx, userID, now)
	if err != nil || !ok {
		return Interval{}, false, err
	}
	by := EndedByUser
	open.EndedAt, open.EndedBy = &now, &by
	if err := r.db.WithContext(ctx).Model(&Interval{}).
		Where("id = ?", open.ID).
		Updates(map[string]any{"ended_at": now, "ended_by": by}).Error; err != nil {
		return Interval{}, false, fmt.Errorf("fasting: end: %w", err)
	}
	return open, true, nil
}

// Open returns the fast that is running at `now`, if there is one.
//
// Openness is COMPUTED, never a column read (kora#407 decision 2: "the
// food-log and cap endings are computed, never stored -- so 'is a fast open?'
// is always a computed question"). ended_at IS NULL only means nobody tapped
// End; the fast may still have ended hours ago because the user ate, or
// because it hit the 48h cap. A bare column read here reported those fasts as
// still running, which had three consequences, the last of them a safety one:
//
//   - GET /v1/fasting/current showed a fast that ended days ago
//   - Start returned that stale row instead of declaring the new fast, so the
//     new one was never recorded
//   - and so guardrails read the stale fast's short duration instead of the
//     real one's, leaving AtRisk false where the 24h threshold should have
//     fired -- under-firing an eating-disorder guardrail for anyone who ends
//     a fast by eating rather than by tapping.
//
// The newest physically-open row wins. Older ones can only be fasts that a
// meal or the cap already ended (otherwise the newer one could not have been
// started), and they stay in the table because nothing implicit ever writes
// ended_at -- they are still counted, at their true capped durations, by
// Since and the coach grounder.
//
// A FirstLogSource failure propagates rather than degrading to "no log", for
// the reason decision 5 gives about fasting reads generally: swallowing it
// would report a fast as open, which inflates or deflates a risk input on
// unknown state instead of failing loudly.
func (r Repository) Open(ctx context.Context, userID uuid.UUID, now time.Time) (Interval, bool, error) {
	var in Interval
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND ended_at IS NULL", userID).
		Order("started_at DESC").First(&in).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Interval{}, false, nil
	}
	if err != nil {
		return Interval{}, false, fmt.Errorf("fasting: open: %w", err)
	}

	var firstLog *time.Time
	if r.firstLogs != nil {
		firstLog, err = r.firstLogs.FirstLogAfter(ctx, r.db, userID, in.StartedAt)
		if err != nil {
			return Interval{}, false, fmt.Errorf("fasting: open: first log: %w", err)
		}
	}
	// EffectiveEnd is bounded above by now, so an end strictly before now is
	// an end that has already happened: a meal, or the cap.
	if EffectiveEnd(in, firstLog, now).Before(now) {
		return Interval{}, false, nil
	}
	return in, true, nil
}

// Since returns intervals that could intersect a window starting at `from`:
// anything that ended after it, plus anything still open.
func (r Repository) Since(ctx context.Context, userID uuid.UUID, from time.Time) ([]Interval, error) {
	out := []Interval{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND (ended_at IS NULL OR ended_at >= ?)", userID, from).
		Order("started_at ASC").Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("fasting: since: %w", err)
	}
	return out, nil
}
