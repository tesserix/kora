package feedback

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ErrNotFound is returned by UpdateStatus when no feedback row has the id.
// The handler maps it to 404; every other error is a 500.
var ErrNotFound = errors.New("feedback: not found")

// DefaultLimit and MaxLimit bound a page. MaxLimit is lower than admin's 200
// because a feedback row carries a free-text description, so a page is far
// heavier than a food or an audit event.
const (
	DefaultLimit = 50
	MaxLimit     = 100
)

// ListParams filters the admin list. Nil Status/Kind mean "no filter" — an
// unset filter and an invalid one are different things, and the handler
// rejects the invalid case before it reaches here.
type ListParams struct {
	Status *Status
	Kind   *Kind
	Limit  int
	Offset int
}

// Item is one row plus the submitter identity the feedback table deliberately
// does not store. Without the join a row is unactionable: you cannot tell
// whether "it crashed" came from a tester you can reach or one you cannot.
type Item struct {
	Feedback
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

// ListResult carries the page plus the count of ALL matching rows, not the
// page length, so the portal can render "showing 50 of 812".
type ListResult struct {
	Items []Item `json:"items"`
	Total int64  `json:"total"`
}

func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultLimit
	case limit > MaxLimit:
		// Clamp to MaxLimit, NOT DefaultLimit: the portal computes
		// offset = page * the limit IT asked for, so silently falling back
		// to a smaller page would make the next offset skip rows that Total
		// truthfully says exist.
		return MaxLimit
	default:
		return limit
	}
}

// List returns one page of feedback, newest first, with the submitter joined.
func (r Repository) List(ctx context.Context, p ListParams) (ListResult, error) {
	p.Limit = clampLimit(p.Limit)
	if p.Offset < 0 {
		p.Offset = 0
	}

	q := r.db.WithContext(ctx).Model(&Feedback{})
	if p.Status != nil {
		q = q.Where("feedback.status = ?", string(*p.Status))
	}
	if p.Kind != nil {
		q = q.Where("feedback.kind = ?", string(*p.Kind))
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return ListResult{}, fmt.Errorf("feedback: count: %w", err)
	}

	var items []Item
	// Order by (created_at DESC, id DESC), never created_at alone. created_at
	// is not unique — two submissions inside the same clock tick, or seeded
	// fixtures, share a timestamp — and an unstable sort makes a row appear on
	// two consecutive pages while another is skipped entirely. This mirrors
	// admin.ListEvents, which documents the same trap.
	//
	// The status filter above is what finally uses ix_feedback_status_created
	// (migration 000019), an index nothing has queried until now.
	if err := q.
		Select("feedback.*, users.email AS email, COALESCE(users.display_name, '') AS display_name").
		Joins("JOIN users ON users.id = feedback.user_id").
		Order("feedback.created_at DESC, feedback.id DESC").
		Limit(p.Limit).Offset(p.Offset).
		Find(&items).Error; err != nil {
		return ListResult{}, fmt.Errorf("feedback: list: %w", err)
	}
	return ListResult{Items: items, Total: total}, nil
}

// UpdateStatus writes ONLY the status column. subject, description, kind and
// the device context are the user's own words and must never be rewritten by
// an operator, so they are not in the update set at all — the strongest
// available guarantee, versus relying on callers to pass them unchanged.
func (r Repository) UpdateStatus(ctx context.Context, id uuid.UUID, s Status) (Feedback, error) {
	res := r.db.WithContext(ctx).Model(&Feedback{}).
		Where("id = ?", id).
		Update("status", string(s))
	if res.Error != nil {
		return Feedback{}, fmt.Errorf("feedback: update status: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Feedback{}, ErrNotFound
	}

	var out Feedback
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&out).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return Feedback{}, ErrNotFound
		}
		return Feedback{}, fmt.Errorf("feedback: reload after update: %w", err)
	}
	return out, nil
}
