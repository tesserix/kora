package fasting

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) Handler { return Handler{repo: repo} }

// resolveUser mirrors tracking.Handler.resolveUser: user.IDFromContext reads
// the users.id set by user.ResolveMiddleware, which is what the auth
// middleware actually populates the context with, not a raw "user_id" key.
func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) Start(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	now := time.Now()
	in, err := h.repo.Start(c.Request.Context(), userID, now, now.In(user.LocFromContext(c)))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not start the fast")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}

func (h Handler) End(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	in, ended, err := h.repo.End(c.Request.Context(), userID, time.Now())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not end the fast")
		return
	}
	if !ended {
		// Nothing open is not an error: the screen had gone stale.
		c.JSON(http.StatusOK, gin.H{"data": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}

func (h Handler) Current(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	in, open, err := h.repo.Open(c.Request.Context(), userID, time.Now())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not read the fast")
		return
	}
	if !open {
		c.JSON(http.StatusOK, gin.H{"data": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}
