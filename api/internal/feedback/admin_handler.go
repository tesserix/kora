package feedback

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

// AdminHandler serves the bffauth-protected /v1/admin/feedback endpoints.
// Separate from Handler (the user-facing capture endpoint) because the two
// have different auth, different callers and no shared request shapes.
type AdminHandler struct {
	repo Repository
}

func NewAdminHandler(r Repository) AdminHandler { return AdminHandler{repo: r} }

// intParam parses a non-negative integer query param. An absent param is 0
// (meaning "unset"), a malformed or negative one is an error the caller turns
// into a 400 — never a silently-ignored filter.
func intParam(c *gin.Context, name string) (int, error) {
	raw := c.Query(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, strconv.ErrRange
	}
	return v, nil
}

// List serves GET /v1/admin/feedback?status=&kind=&limit=&offset=.
func (h AdminHandler) List(c *gin.Context) {
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

	params := ListParams{Limit: limit, Offset: offset}

	// An unrecognised filter value is a 400, NOT an ignored filter. Silently
	// dropping it would show the operator an unfiltered list while the UI
	// claims it is filtered.
	if raw := c.Query("status"); raw != "" {
		s := Status(raw)
		if !s.Valid() {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "status must be one of open, in_progress, resolved, closed")
			return
		}
		params.Status = &s
	}
	if raw := c.Query("kind"); raw != "" {
		k := Kind(raw)
		if !k.Valid() {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "kind must be one of bug, feature")
			return
		}
		params.Kind = &k
	}

	result, err := h.repo.List(c.Request.Context(), params)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, result)
}

type updateStatusRequest struct {
	Status Status `json:"status"`
}

// UpdateStatus serves PATCH /v1/admin/feedback/:id. Status is the only
// mutable field.
func (h AdminHandler) UpdateStatus(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}

	var req updateStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "body must be {\"status\": \"...\"}")
		return
	}
	if !req.Status.Valid() {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "status must be one of open, in_progress, resolved, closed")
		return
	}

	updated, err := h.repo.UpdateStatus(c.Request.Context(), id, req.Status)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "feedback not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, updated)
}
