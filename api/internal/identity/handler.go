package identity

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Lookup is limited to LookupLimit calls per LookupPeriod per authenticated
// caller. 20/minute is generous for a human typing a handle a friend read out,
// and ruinous for walking the handle space: even at the full rate, enumerating
// a five-character alphabet takes longer than the app will exist.
const (
	LookupLimit  = 20
	LookupPeriod = time.Minute
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// writeErr maps the four write failures to four distinguishable answers.
//
// "Taken" is answered honestly, and that is not a privacy leak: a handle's
// existence is discoverable by definition, because exact-match lookup exists.
// Hiding it here would only make claiming a handle a guessing game.
func writeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrHandleInvalid):
		httpx.Error(c, http.StatusBadRequest, "invalid_handle",
			"Handles are 3–20 characters: letters, numbers and underscores.")
	case errors.Is(err, ErrHandleReserved):
		httpx.Error(c, http.StatusConflict, "handle_reserved",
			"That handle is reserved.")
	case errors.Is(err, ErrHandleTaken):
		httpx.Error(c, http.StatusConflict, "handle_taken",
			"That handle is taken.")
	case errors.Is(err, ErrHandleRetired):
		httpx.Error(c, http.StatusConflict, "handle_retired",
			"That handle was used before and can't be reused.")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "not found")
	default:
		httpx.RespondServiceError(c, err)
	}
}

// Lookup resolves one handle to one person. There is no listing form of this
// endpoint and there must never be one.
func (h Handler) Lookup(c *gin.Context) {
	viewerID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	raw := c.Query("handle")
	if raw == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "handle is required")
		return
	}
	view, err := h.svc.Lookup(c.Request.Context(), viewerID, raw)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "No Kora account has that handle.")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, view)
}

func (h Handler) GetHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	handle, err := h.svc.MyHandle(c.Request.Context(), uid)
	if err != nil {
		writeErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"handle": handle})
}

func (h Handler) SetHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var body struct {
		Handle string `json:"handle"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "handle is required")
		return
	}
	handle, err := h.svc.Claim(c.Request.Context(), uid, body.Handle)
	if err != nil {
		writeErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"handle": handle})
}

func (h Handler) ClearHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.svc.Clear(c.Request.Context(), uid); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
