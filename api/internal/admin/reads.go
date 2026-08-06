package admin

import (
	"context"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
)

// FoodDetail is one food plus the facts the portal needs ABOUT it that are not
// on the row itself.
//
// It exists because two task-8 surfaces cannot be built from ListFoods:
//
//   - The edit form needs `updated_at` to echo as PATCH's optimistic-concurrency
//     precondition (rider 1). ListFoods returns nutrition.FoodItem, which has
//     no UpdatedAt field at all — so there is nothing to read, not merely
//     something inconvenient to read.
//   - The delete confirmation must show how many logs reference the food before
//     retiring it. The task brief is explicit that this number needs an
//     endpoint or a field rather than being invented in the client, so it is
//     computed here, in SQL.
type FoodDetail struct {
	Food FoodSnapshot `json:"food"`

	// LogCount is how many food_logs rows still point at this food.
	//
	// It is a WEIGHT, not a blocker: retiring a food does not delete or
	// orphan these logs. food_logs.food_item_id is ON DELETE SET NULL, but a
	// soft delete does not trigger that — the logs keep their reference and
	// their already-denormalised macros, so historical days keep rendering
	// exactly as before. The number is here so an operator retiring a food
	// with 4,000 logs against it knows that before clicking, not after.
	LogCount int64 `json:"log_count"`
}

// EventListParams filters and pages kora_admin_events. TargetID is a pointer
// so "not filtering" is distinguishable from "filtering on the zero UUID",
// which would silently match nothing.
type EventListParams struct {
	Limit    int
	Offset   int
	TargetID *uuid.UUID
}

type EventListResult struct {
	Items []AdminEvent `json:"items"`
	Total int64        `json:"total"`
}

// FoodReader is the full read surface the handler depends on. It EMBEDS
// FoodLister rather than restating ListFoods, so there is exactly one
// declaration of that method signature and the two interfaces cannot drift
// into disagreeing about it.
type FoodReader interface {
	FoodLister
	GetFood(ctx context.Context, id uuid.UUID) (FoodDetail, error)
	ListEvents(ctx context.Context, p EventListParams) (EventListResult, error)
}

var _ FoodReader = Repository{}

// GetFood loads one food and the number of logs referencing it.
//
// Deliberately NOT live-only: an already-retired food must stay loadable so
// the audit page can show what was retired, and so a stale portal tab lands on
// "this food is retired" rather than a bare 404 that reads as "never existed".
// DeletedAt is on the response, so the caller can tell the two apart — the
// same reasoning that made SoftDeleteFood return a FoodSnapshot (rider 3).
func (r Repository) GetFood(ctx context.Context, id uuid.UUID) (FoodDetail, error) {
	db := r.db.WithContext(ctx)

	snap, err := loadFoodSnapshot(db, id)
	if err != nil {
		// Pass gorm.ErrRecordNotFound through unwrapped-by-value so the
		// handler's errors.Is check still matches; wrapping with %w would too,
		// but a bare return keeps the sentinel exact for callers that compare
		// with ==.
		if err == gorm.ErrRecordNotFound {
			return FoodDetail{}, err
		}
		return FoodDetail{}, fmt.Errorf("admin: get food: %w", err)
	}

	var logCount int64
	if err := db.Table("food_logs").Where("food_item_id = ?", id).Count(&logCount).Error; err != nil {
		return FoodDetail{}, fmt.Errorf("admin: get food: count logs: %w", err)
	}

	return FoodDetail{Food: snap, LogCount: logCount}, nil
}

// ListEvents returns one page of the admin audit trail, newest first, plus the
// total number of MATCHING rows (not the page length) so the portal can render
// "showing 50 of 812" — the same contract ListFoods documents.
func (r Repository) ListEvents(ctx context.Context, p EventListParams) (EventListResult, error) {
	p.Limit = clampLimit(p.Limit)
	if p.Offset < 0 {
		p.Offset = 0
	}

	q := r.db.WithContext(ctx).Model(&AdminEvent{})
	if p.TargetID != nil {
		q = q.Where("target_id = ?", *p.TargetID)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return EventListResult{}, fmt.Errorf("admin: count events: %w", err)
	}

	var items []AdminEvent
	// Order by (created_at DESC, id DESC), never created_at alone. created_at
	// is not unique here — the three mutations behind a single portal action
	// can land inside the same clock tick, and two events inserted in the same
	// transaction routinely share a timestamp. Without the id tiebreaker the
	// sort is unstable, so a row can appear on two consecutive pages while
	// another is skipped entirely. This matches ListFoods' (name, id) ordering
	// for the same reason.
	//
	// idx_kora_admin_events_created (created_at DESC) and
	// idx_kora_admin_events_target (target_id, created_at DESC) serve the
	// unfiltered and filtered forms respectively (migration 000023).
	if err := q.Order("created_at DESC, id DESC").Limit(p.Limit).Offset(p.Offset).
		Find(&items).Error; err != nil {
		return EventListResult{}, fmt.Errorf("admin: list events: %w", err)
	}
	return EventListResult{Items: items, Total: total}, nil
}

// GetFood serves GET /v1/admin/foods/:id.
func (h Handler) GetFood(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}

	detail, err := h.foods.GetFood(c.Request.Context(), id)
	if err != nil {
		if isRecordNotFound(err) {
			httpx.Error(c, http.StatusNotFound, "not_found", "food not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, detail)
}

// ListEvents serves GET /v1/admin/events?limit=&offset=&target_id=.
func (h Handler) ListEvents(c *gin.Context) {
	limit, err := intParam(c, "limit")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "limit must be a non-negative integer")
		return
	}
	offset, err := intParam(c, "offset")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "offset must be a non-negative integer")
		return
	}

	// An ABSENT target_id means "every event". A malformed one is a 400, never
	// a silently-dropped filter: quietly listing the whole audit trail when the
	// caller asked for one food's history would look like a working page
	// showing the wrong thing.
	var targetID *uuid.UUID
	if raw := c.Query("target_id"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "target_id must be a UUID")
			return
		}
		targetID = &parsed
	}

	result, err := h.foods.ListEvents(c.Request.Context(), EventListParams{
		Limit:    limit,
		Offset:   offset,
		TargetID: targetID,
	})
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	// Never let a nil slice serialise as null: the audit page maps over it.
	if result.Items == nil {
		result.Items = []AdminEvent{}
	}
	httpx.OK(c, result)
}
