package notifications

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	items, err := h.svc.List(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load notifications")
		return
	}
	httpx.OK(c, items)
}

func (h Handler) UnreadCount(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	n, err := h.svc.UnreadCount(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load count")
		return
	}
	httpx.OK(c, gin.H{"count": n})
}

func (h Handler) MarkAllRead(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	n, err := h.svc.MarkAllRead(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not mark read")
		return
	}
	httpx.OK(c, gin.H{"marked": n})
}
