package platformadmin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Entity types Kora exposes. `type` is product-defined by the contract.
const (
	TypeUsers = "users"
	TypeFoods = "foods"
)

// EntityTypes is the closed set, in the order an unknown type is reported
// back. Membership lives here rather than in a switch so the 404's message
// and the router can never disagree about what exists.
var EntityTypes = []string{TypeUsers, TypeFoods}

// MinSearchChars is the shortest `q` this endpoint will run.
//
// This is the enumeration guard #433 asks for, and one character is not
// enough: "a" would return most of the user table. It is a floor on the
// SEARCH, not on the route — an absent q is refused outright below, which is
// the case that matters, because a blank search returning every user is
// precisely how a directory becomes a data dump.
const MinSearchChars = 2

// Entity is one searchable record, in the shape the Directory and ⌘K need
// and no larger.
//
// Sublabel is what distinguishes two records with the same Label. For a user
// that is their handle when they have one and their email otherwise —
// Kora's own social.FriendView never exposes an email, and this follows it as
// far as it can, but a directory that cannot tell two people called "Alex"
// apart does not do the job #433 exists to do. Nothing else about a user
// leaves through here: no firebase_uid, no targets, no intake, no counts.
type Entity struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Label     string `json:"label"`
	Sublabel  string `json:"sublabel,omitempty"`
	CreatedAt string `json:"created_at"`
}

// EntityResult is a page of records plus the unpaged total.
type EntityResult struct {
	Items []Entity
	Total int64
}

// EntitySource searches Kora's records.
type EntitySource interface {
	SearchEntities(ctx context.Context, entityType, q string, limit, offset int) (EntityResult, error)
}

// userRow is the projection SearchEntities selects for a user. It is
// deliberately narrower than user.AdminRow: this surface answers "which
// record is this", not "what has this person done".
type userRow struct {
	ID          uuid.UUID
	Email       *string
	DisplayName *string
	Handle      *string
	CreatedAt   time.Time
}

type foodRow struct {
	ID        uuid.UUID
	Name      string
	Brand     string
	CreatedAt time.Time
}

// ErrUnknownEntityType is returned for a type outside EntityTypes. A caller
// asking for a type Kora does not have is a 404, distinct from a known type
// that happens to be empty — which is a 200 with no rows (§4.5).
var ErrUnknownEntityType = fmt.Errorf("platformadmin: unknown entity type")

// SearchEntities runs the search for one entity type.
//
// Matching is case-insensitive substring on the human-facing fields only.
// Deliberately NOT on id: an operator pasting a uuid is looking that record
// up, not searching, and matching against a uuid column would cost a scan on
// every query to serve a case the Directory does not have.
//
// # The leading wildcard is a known cost
//
// `LIKE '%q%'` cannot use an index, and neither existing food_items index
// helps: idx_food_items_name is a tsvector GIN (word matching, not
// substring) and idx_food_items_name_trgm is a plain btree on lower(name)
// despite its name. So both the page AND the count scan the table — the
// count is the expensive half, since it cannot stop at Limit rows.
//
// That is accepted rather than overlooked. Substring matching is what a ⌘K
// directory is for ("quux" must find "Quuxberry"), and switching to
// to_tsvector/plainto_tsquery to get an index would silently change what the
// operator can find. If this becomes slow on the food index, the fix is
// pg_trgm plus a GIN trgm index on lower(name) — which makes THIS query
// indexed without changing its semantics — not a narrower search.
func (r Repository) SearchEntities(ctx context.Context, entityType, q string, limit, offset int) (EntityResult, error) {
	pattern := "%" + strings.ToLower(q) + "%"

	switch entityType {
	case TypeUsers:
		db := r.db.WithContext(ctx).Table("users").
			Where("lower(coalesce(display_name, '')) LIKE ?"+
				" OR lower(coalesce(email, '')) LIKE ?"+
				" OR lower(coalesce(handle, '')) LIKE ?",
				pattern, pattern, pattern)

		var total int64
		if err := db.Count(&total).Error; err != nil {
			return EntityResult{}, fmt.Errorf("platformadmin: count users: %w", err)
		}

		var rows []userRow
		if err := db.Select("id, email, display_name, handle, created_at").
			Order("created_at DESC").Limit(limit).Offset(offset).
			Scan(&rows).Error; err != nil {
			return EntityResult{}, fmt.Errorf("platformadmin: search users: %w", err)
		}

		items := make([]Entity, 0, len(rows))
		for _, u := range rows {
			items = append(items, toUserEntity(u))
		}
		return EntityResult{Items: items, Total: total}, nil

	case TypeFoods:
		// Retired foods are excluded. A soft-deleted food is not findable in
		// the app either, and a directory that surfaces it invites an
		// operator to act on something users cannot see. GET
		// /v1/admin/foods/:id still loads one by id, which is the surface
		// that exists for inspecting what was retired.
		db := r.db.WithContext(ctx).Table("food_items").
			Where("deleted_at IS NULL").
			Where("lower(name) LIKE ? OR lower(brand) LIKE ?", pattern, pattern)

		var total int64
		if err := db.Count(&total).Error; err != nil {
			return EntityResult{}, fmt.Errorf("platformadmin: count foods: %w", err)
		}

		var rows []foodRow
		if err := db.Select("id, name, brand, created_at").
			Order("created_at DESC").Limit(limit).Offset(offset).
			Scan(&rows).Error; err != nil {
			return EntityResult{}, fmt.Errorf("platformadmin: search foods: %w", err)
		}

		items := make([]Entity, 0, len(rows))
		for _, f := range rows {
			items = append(items, Entity{
				ID:        f.ID.String(),
				Type:      TypeFoods,
				Label:     f.Name,
				Sublabel:  f.Brand,
				CreatedAt: stamp(f.CreatedAt),
			})
		}
		return EntityResult{Items: items, Total: total}, nil

	default:
		return EntityResult{}, ErrUnknownEntityType
	}
}

// toUserEntity builds the Directory row for a user.
//
// Label falls back through display name, then handle, then a truncated id,
// because every one of the three can be absent: display_name and email are
// both nullable on users (migration 000001) and handle is opt-in (000056). A
// row with an empty label renders as a blank line the operator cannot click
// with confidence.
func toUserEntity(u userRow) Entity {
	label := deref(u.DisplayName)
	sublabel := deref(u.Handle)
	if sublabel == "" {
		sublabel = deref(u.Email)
	}
	if label == "" {
		label = sublabel
	}
	if label == "" {
		label = u.ID.String()
	}

	return Entity{
		ID:        u.ID.String(),
		Type:      TypeUsers,
		Label:     label,
		Sublabel:  sublabel,
		CreatedAt: stamp(u.CreatedAt),
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// EntitiesHandler serves GET /admin/entities/{type}.
type EntitiesHandler struct {
	src    EntitySource
	logger *slog.Logger
}

// NewEntitiesHandler builds the handler. logger may be nil.
func NewEntitiesHandler(src EntitySource, logger *slog.Logger) *EntitiesHandler {
	return &EntitiesHandler{src: src, logger: logger}
}

// Search handles GET /admin/entities/:type?q=…
func (h *EntitiesHandler) Search(c *gin.Context) {
	entityType := c.Param("type")
	if !knownEntityType(entityType) {
		httpx.Error(c, http.StatusNotFound, "not_found",
			"entity type must be one of "+strings.Join(EntityTypes, ", "))
		return
	}

	q := parseQuery(c, nowUTC())

	// A blank or one-character q is refused, not silently answered with the
	// whole table. This is a search endpoint over user records; the failure
	// mode it must not have is "returns everything when asked for nothing".
	if len([]rune(q.Search)) < MinSearchChars {
		httpx.Error(c, http.StatusBadRequest, "invalid_input",
			fmt.Sprintf("q is required and must be at least %d characters", MinSearchChars))
		return
	}

	result, err := h.src.SearchEntities(c.Request.Context(), entityType, q.Search, q.Limit, q.Offset())
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: search entities", "type", entityType, "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error",
			"could not search records")
		return
	}

	// Allocated, never nil: §4.5. "No record matches" is a real answer and
	// must not look like a broken search.
	items := result.Items
	if items == nil {
		items = []Entity{}
	}
	page(c, items, Pagination{Page: q.Page, Limit: q.Limit, Total: result.Total})
}

func knownEntityType(t string) bool {
	for _, known := range EntityTypes {
		if t == known {
			return true
		}
	}
	return false
}
