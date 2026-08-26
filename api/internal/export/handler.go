package export

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Reader is the export service the handler depends on.
type Reader interface {
	ForUser(ctx context.Context, userID uuid.UUID) (Document, error)
}

// Handler serves GET /v1/me/export.
type Handler struct {
	svc    Reader
	logger *slog.Logger
	now    func() time.Time
}

// NewHandler builds the handler. logger may be nil.
func NewHandler(svc Reader, logger *slog.Logger) Handler {
	return Handler{svc: svc, logger: logger, now: time.Now}
}

// Export serves GET /v1/me/export.
//
// The user id comes from IDFromContext (set by ResolveMiddleware), exactly as
// DeleteMe's does — there is no user id in the request to forge, and an
// export endpoint that took one would be a way to read any account.
//
// Synchronous, in one response. That is a scale decision, not an oversight:
// Kora is pre-launch with one real account and a 10–15 tester beta ahead of
// it, and an async job would need a job table, a worker and an expiring-link
// story none of which exist. The point at which it stops being right is when
// one user's rows no longer fit comfortably in memory — food_logs is the
// table that would get there first, and Content-Length in the access log is
// what would show it happening.
func (h Handler) Export(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}

	doc, err := h.svc.ForUser(c.Request.Context(), id)
	if err != nil {
		if h.logger != nil {
			// The error names the table that failed; that is the one thing
			// worth having when a user reports a broken export.
			h.logger.Error("export: build failed", "user_id", id, "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error",
			"could not build your export")
		return
	}

	// Content-Disposition so a browser or the app saves a file rather than
	// rendering it. The date is in the name because someone will keep several.
	c.Header("Content-Disposition", fmt.Sprintf(
		`attachment; filename="kora-export-%s.json"`, h.now().UTC().Format("2006-01-02")))
	// This response is one person's entire health history. No cache, at any
	// hop — a shared or disk cache holding it is a copy nobody accounted for.
	c.Header("Cache-Control", "no-store")

	// NOT httpx.OK: that wraps in {"data": ...}. This document is its own
	// envelope and is served at the top level — see Document.Tables for why
	// its table map is keyed "tables" rather than "data", which is the half of
	// this that the mobile client would otherwise silently unwrap.
	c.JSON(http.StatusOK, doc)
}
