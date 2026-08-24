package fasting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

// pgUniqueViolation is the Postgres SQLSTATE for a unique-constraint
// violation (23505). Same rationale as admin/mutations.go:21-28: gorm.Config
// here has no TranslateError, so gorm.ErrDuplicatedKey is never returned --
// the only way to recognise this failure is to unwrap the raw driver error.
const pgUniqueViolation = "23505"

// startRaceHook, when non-nil, is called by Start immediately after Open()
// reports no fast is currently open and BEFORE the INSERT that might race
// against a concurrent Start for the same user. It exists only so
// TestStartHandlesGenuineConcurrentStarts can force many goroutines to
// overlap deterministically inside that window -- a bare goroutine race
// against a fast local Postgres round-trip was observed to frequently NOT
// overlap at all (each Start completing before the next one's Open ran),
// which would make that test pass without ever exercising the 23505 path.
// Production code never sets this; it is always nil there and this branch
// is then a no-op.
var startRaceHook func()

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Start opens a fast, or returns the one already open.
//
// Idempotent on purpose: a double-tap and a client retry are the same request
// as far as the user is concerned, and a 400 for either would be a bug the user
// experiences as the button not working.
//
// The read-then-insert below (Open, then Create) is not atomic with itself:
// two genuinely concurrent Starts for the same user can both observe "none
// open" and both attempt the INSERT. fasting_intervals_one_open (the partial
// unique index) correctly rejects the loser with SQLSTATE 23505 -- but
// returning that error as-is would surface as a 500, which is exactly the
// "double-tap 400" bug the idempotency contract exists to prevent, just
// louder. Same race, same fix as admin/mutations.go's CreateFood barcode
// backstop (task-5 brief, Rider 2): unwrap the raw driver error, and on a
// 23505 re-read Open() instead of failing -- the loser gets back the winner's
// row, which is what "idempotent" means here. Only if that re-read also comes
// up empty (something other than this exact race) does the error surface.
func (r Repository) Start(ctx context.Context, userID uuid.UUID, now, localDate time.Time) (Interval, error) {
	if existing, ok, err := r.Open(ctx, userID); err != nil {
		return Interval{}, err
	} else if ok {
		return existing, nil
	}
	if startRaceHook != nil {
		startRaceHook()
	}
	in := Interval{UserID: userID, StartedAt: now, LocalDate: localDate}
	if err := r.db.WithContext(ctx).Create(&in).Error; err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			if existing, ok, openErr := r.Open(ctx, userID); openErr == nil && ok {
				return existing, nil
			}
		}
		return Interval{}, fmt.Errorf("fasting: start: %w", err)
	}
	return in, nil
}

// End closes the open fast. ok is false when there was nothing open, which is
// not an error -- the user tapped end on a screen that had gone stale.
//
// ended_at and ended_by are always written together: the table's CHECK
// constraints validate each independently but not as a pair, and this is the
// only write path that sets either.
func (r Repository) End(ctx context.Context, userID uuid.UUID, now time.Time) (Interval, bool, error) {
	open, ok, err := r.Open(ctx, userID)
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

func (r Repository) Open(ctx context.Context, userID uuid.UUID) (Interval, bool, error) {
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
