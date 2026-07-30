package coach

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Handler exposes the coach's nudges and Q&A endpoints over Service.
type Handler struct {
	svc *Service
}

// NewHandler builds a Handler over svc.
func NewHandler(svc *Service) Handler {
	return Handler{svc: svc}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// Nudges returns the guardrail-gated nudges the coach currently has for the
// authenticated user.
func (h Handler) Nudges(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	result, err := h.svc.Nudges(c.Request.Context(), userID, now, loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, gin.H{"nudges": result.Nudges, "showSupport": result.ShowSupport})
}

// askRequest is the Ask endpoint's request body.
type askRequest struct {
	Question string `json:"question"`
}

// Ask answers a free-text question grounded over the authenticated user's
// Context.
func (h Handler) Ask(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	var req askRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed request body")
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	answer, err := h.svc.Ask(c.Request.Context(), userID, now, loc, req.Question)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, gin.H{"answer": answer.Text, "citations": answer.Citations, "showSupport": answer.ShowSupport})
}
