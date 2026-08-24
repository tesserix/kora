package fasting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Start opens a fast, or returns the one already open.
//
// Idempotent on purpose: a double-tap and a client retry are the same request
// as far as the user is concerned, and a 400 for either would be a bug the user
// experiences as the button not working.
func (r Repository) Start(ctx context.Context, userID uuid.UUID, now, localDate time.Time) (Interval, error) {
	if existing, ok, err := r.Open(ctx, userID); err != nil {
		return Interval{}, err
	} else if ok {
		return existing, nil
	}
	in := Interval{UserID: userID, StartedAt: now, LocalDate: localDate}
	if err := r.db.WithContext(ctx).Create(&in).Error; err != nil {
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
