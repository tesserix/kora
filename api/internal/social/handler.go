package social

import (
	"errors"
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

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func mapErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrBadInput):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "provide exactly one of email or code")
	case errors.Is(err, ErrUserNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "no Kora account matches that email or code")
	case errors.Is(err, ErrSelfFriend):
		httpx.Error(c, http.StatusConflict, "conflict", "you can't add yourself")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

func (h Handler) ListFriends(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	views, err := h.svc.ListFriends(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, views)
}

func (h Handler) ListRequests(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	incoming, outgoing, err := h.svc.ListRequests(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"incoming": incoming, "outgoing": outgoing})
}

type sendRequestBody struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

func (h Handler) SendRequest(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req sendRequestBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	f, err := h.svc.SendRequest(c.Request.Context(), uid, req.Email, req.Code)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": f})
}

func (h Handler) Accept(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request id")
		return
	}
	if err := h.svc.Accept(c.Request.Context(), uid, id); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"accepted": true})
}

func (h Handler) Decline(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request id")
		return
	}
	if err := h.svc.Decline(c.Request.Context(), uid, id); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"declined": true})
}

func (h Handler) Unfriend(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	other, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid user id")
		return
	}
	if err := h.svc.Unfriend(c.Request.Context(), uid, other); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"removed": true})
}

func (h Handler) Code(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	code, link, err := h.svc.MyCode(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"code": code, "link": link})
}
