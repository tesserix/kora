// Package admin serves the platform admin surfaces behind the signed BFF path.
// Its callers are tesserix-home operators, never end users, so nothing here
// scopes by Kora user id — authorization is bffauth's job, upstream.
package admin

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// DefaultLimit and MaxLimit bound a page. MaxLimit is generous compared with
// nutrition.searchLimitMax (25) because this pages an index of ~7,900 rows for
// a human with a table, not a mobile picker.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

type ListParams struct {
	Query  string
	Limit  int
	Offset int
}

type ListResult struct {
	Items []nutrition.FoodItem `json:"items"`
	Total int64                `json:"total"`
}

// FoodLister is the read surface the handler depends on, so handler tests need
// no database.
type FoodLister interface {
	ListFoods(ctx context.Context, p ListParams) (ListResult, error)
}

type Repository struct {
	db *gorm.DB
}

// Compile-time assertion that Repository satisfies FoodLister. Without this,
// a signature drift between the two compiles clean here and only surfaces
// when the next task wires Repository into NewHandler.
var _ FoodLister = Repository{}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// ListFoods returns one page of the food index plus the total number of rows
// matching the filter. Total counts MATCHES, not the page, so the caller can
// render "showing 50 of 7,898".
func (r Repository) ListFoods(ctx context.Context, p ListParams) (ListResult, error) {
	p.Limit = clampLimit(p.Limit)
	if p.Offset < 0 {
		p.Offset = 0
	}

	q := r.db.WithContext(ctx).Model(&nutrition.FoodItem{}).Where("deleted_at IS NULL")
	if p.Query != "" {
		pattern := "%" + p.Query + "%"
		q = q.Where("name ILIKE ? OR brand ILIKE ?", pattern, pattern)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return ListResult{}, fmt.Errorf("admin: count foods: %w", err)
	}

	var items []nutrition.FoodItem
	// Order by (name, id): name alone is not unique in this table, and an
	// unstable sort makes paging drop or repeat rows between pages.
	if err := q.Order("name ASC, id ASC").Limit(p.Limit).Offset(p.Offset).
		Find(&items).Error; err != nil {
		return ListResult{}, fmt.Errorf("admin: list foods: %w", err)
	}
	return ListResult{Items: items, Total: total}, nil
}

// clampLimit resolves a caller-requested Limit to the value ListFoods
// actually uses. Pulled out of ListFoods as its own function so the bound is
// testable directly, WITHOUT a database and WITHOUT depending on how many
// rows happen to be in food_items: a row-count-based test (seed N rows,
// request over MaxLimit, assert the returned page length) cannot tell
// "clamped to MaxLimit" apart from "not clamped at all" unless the seeded
// row count itself exceeds MaxLimit, which is exactly the failure mode this
// split closes.
func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultLimit
	case limit > MaxLimit:
		// Clamp to MaxLimit, NOT DefaultLimit. The portal's pager computes
		// offset = page * requestedLimit using the limit IT asked for. If an
		// over-max request silently fell back to a smaller DefaultLimit, the
		// next page's offset would jump past rows the previous page never
		// returned — silently skipping them, even though Total truthfully
		// reports they exist. Nothing in the response echoes the effective
		// limit, so the client has no way to detect a fallback to a
		// different value than what it requested; MaxLimit at least honours
		// the client's intent to get "a lot," bounded to what we allow.
		return MaxLimit
	default:
		return limit
	}
}
