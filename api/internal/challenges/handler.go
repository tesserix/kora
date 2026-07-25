package challenges

import (
	"errors"
	"net/http"
	"time"

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

func (h Handler) parseID(c *gin.Context, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(param))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

func mapErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrBadInput):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid input")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "challenge not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

type createBody struct {
	Title    string `json:"title"`
	Metric   string `json:"metric"`
	Duration string `json:"duration"`
}

func (h Handler) Create(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req createBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	now := time.Now().In(user.LocFromContext(c))
	ch, err := h.svc.Create(c.Request.Context(), uid, gid, req.Title, Metric(req.Metric), req.Duration, now)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": ch})
}

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	items, err := h.svc.List(c.Request.Context(), uid, gid, time.Now(), user.LocFromContext(c))
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h Handler) Join(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Join(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"joined": true})
}

func (h Handler) Leave(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Leave(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"left": true})
}

func (h Handler) Detail(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	d, err := h.svc.Detail(c.Request.Context(), uid, cid, time.Now(), user.LocFromContext(c))
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, d)
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
