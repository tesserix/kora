package devices

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler { return Handler{repo: repo} }

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

type registerRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

func (h Handler) Register(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	if req.Token == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "token is required")
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "platform must be ios or android")
		return
	}
	if err := h.repo.Upsert(c.Request.Context(), uid, req.Token, req.Platform); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not register device")
		return
	}
	httpx.OK(c, gin.H{"registered": true})
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	token := c.Param("token")
	if token == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "token is required")
		return
	}
	if err := h.repo.DeleteByToken(c.Request.Context(), uid, token); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not remove device")
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
