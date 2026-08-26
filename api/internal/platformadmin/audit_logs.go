package platformadmin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/admin"
	"github.com/tesserix/kora/api/internal/httpx"
)

// AuditFilter is one read of Kora's audit trail, already bounded.
type AuditFilter struct {
	Query
	Action       string
	Actor        string
	ResourceType string
}

// AuditResult is a page of rows plus the unpaged total.
type AuditResult struct {
	Entries []admin.AdminEvent
	Total   int64
}

// AuditSource reads kora_admin_events. An interface so the handler is
// testable without a database, and so the SQL has exactly one home.
type AuditSource interface {
	ListAudit(ctx context.Context, f AuditFilter) (AuditResult, error)
}

// ListAudit reads a bounded, filtered page of kora_admin_events.
//
// Every row is Kora's by construction: kora_admin_events is Kora's own table
// in Kora's own database, and this process can reach no other product's. That
// is the whole finding behind #431 — the console's shared route validated a
// :product parameter and then queried mark8ly's table regardless, so Kora's
// overview showed mark8ly's rows. Scoping is not a predicate here; it is the
// absence of any way to be wrong.
func (r Repository) ListAudit(ctx context.Context, f AuditFilter) (AuditResult, error) {
	db := r.db.WithContext(ctx).Model(&admin.AdminEvent{})

	if f.Action != "" {
		db = db.Where("action = ?", f.Action)
	}
	if f.Actor != "" {
		// Matches either attribution column. An operator who has an email
		// should not have to know whether the row recorded them by id.
		db = db.Where("actor_email = ? OR actor_id = ?", f.Actor, f.Actor)
	}
	if f.ResourceType != "" {
		db = db.Where("target_type = ?", f.ResourceType)
	}
	if !f.From.IsZero() {
		db = db.Where("created_at >= ?", f.From)
	}
	if !f.To.IsZero() {
		db = db.Where("created_at <= ?", f.To)
	}

	var total int64
	if err := db.Count(&total).Error; err != nil {
		return AuditResult{}, fmt.Errorf("platformadmin: count audit rows: %w", err)
	}

	var rows []admin.AdminEvent
	if err := db.Order("created_at DESC").
		Limit(f.Limit).Offset(f.Offset()).
		Find(&rows).Error; err != nil {
		return AuditResult{}, fmt.Errorf("platformadmin: list audit rows: %w", err)
	}
	return AuditResult{Entries: rows, Total: total}, nil
}

// auditRow is the contract's shape (§3.3), not admin.AdminEvent's.
//
// before/after are deliberately absent: they are row snapshots that can carry
// a food's whole nutrition record, and the estate timeline renders a line per
// event, not a diff. metadata is absent for the reason mark8ly's is — the
// contract's example shows a string while the column is jsonb, and omission
// is the one choice that cannot be wrong while that is unresolved.
type auditRow struct {
	ID        string `json:"id"`
	Actor     string `json:"actor"`
	Action    string `json:"action"`
	Timestamp string `json:"timestamp"`
	Target    string `json:"target,omitempty"`
}

// AuditHandler serves GET /admin/audit-logs.
type AuditHandler struct {
	src    AuditSource
	logger *slog.Logger
	now    func() time.Time
}

// NewAuditHandler builds the handler. logger may be nil.
func NewAuditHandler(src AuditSource, logger *slog.Logger) *AuditHandler {
	return &AuditHandler{src: src, logger: logger, now: time.Now}
}

// List handles GET /admin/audit-logs.
func (h *AuditHandler) List(c *gin.Context) {
	f := AuditFilter{
		Query:        parseQuery(c, h.now()),
		Action:       strings.TrimSpace(c.Query("action")),
		Actor:        strings.TrimSpace(c.Query("actor")),
		ResourceType: strings.TrimSpace(c.Query("resource_type")),
	}

	result, err := h.src.ListAudit(c.Request.Context(), f)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: list audit logs", "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error",
			"could not read audit logs")
		return
	}

	// Allocated, never nil: §4.5. An empty audit trail is a real answer
	// ("nothing happened in this window") and must not be distinguishable
	// from a broken endpoint.
	rows := make([]auditRow, 0, len(result.Entries))
	for _, e := range result.Entries {
		rows = append(rows, toAuditRow(e))
	}

	page(c, rows, Pagination{Page: f.Page, Limit: f.Limit, Total: result.Total})
}

func toAuditRow(e admin.AdminEvent) auditRow {
	return auditRow{
		// Bare id. platform-api namespaces arriving rows as <slug>:<id>;
		// prefixing here would yield "kora:kora:…".
		ID:        e.ID.String(),
		Actor:     auditActor(e),
		Action:    e.Action,
		Timestamp: stamp(e.CreatedAt),
		Target:    auditTarget(e),
	}
}

// auditActor resolves the single "who did it" string the contract asks for.
// Email first because that is what an operator recognises; the opaque id is
// the fallback. "system" is unreachable today — kora_admin_events has a CHECK
// rejecting an empty actor_email — and is here so a future system-written row
// cannot render as an empty cell.
func auditActor(e admin.AdminEvent) string {
	if s := strings.TrimSpace(e.ActorEmail); s != "" {
		return s
	}
	if s := strings.TrimSpace(e.ActorID); s != "" {
		return s
	}
	return "system"
}

// auditTarget collapses target_type + target_id into the contract's single
// `target`. The id wins when present; the type is the fallback for rows that
// have none, which is what a food created without a preassigned id looks
// like.
func auditTarget(e admin.AdminEvent) string {
	if e.TargetID != nil {
		return e.TargetID.String()
	}
	return e.TargetType
}

// Repository reads every table this surface exposes.
//
// One type rather than four because these are five read endpoints over one
// database, and four repositories would mean four *gorm.DB fields that must
// not drift apart.
type Repository struct{ db *gorm.DB }

// NewRepository builds the repository.
func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }
