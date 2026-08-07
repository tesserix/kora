package user

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

func (h Handler) Me(c *gin.Context) {
	uid := c.GetString("uid")
	email := c.GetString("email")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	u, err := h.repo.UpsertByFirebaseUID(c.Request.Context(), uid, email)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}

type shareProgressBody struct {
	ShareProgress bool `json:"share_progress"`
}

func (h Handler) UpdateShareProgress(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req shareProgressBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	if err := h.repo.SetShareProgress(c.Request.Context(), id, req.ShareProgress); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not update sharing")
		return
	}
	u, err := h.repo.ByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}

// MaxDisplayNameLen bounds the name at a length no real name exceeds, so a
// pathological value cannot break the friends list or leaderboard layouts.
const MaxDisplayNameLen = 100

type updateProfileBody struct {
	DisplayName string `json:"display_name"`
}

// UpdateProfile writes the caller's own display name. The row is resolved from
// the auth context by ResolveMiddleware — there is no user id in the request to
// forge.
func (h Handler) UpdateProfile(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req updateProfileBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "display name is required")
		return
	}
	if utf8.RuneCountInString(name) > MaxDisplayNameLen {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "display name is too long")
		return
	}
	if err := h.repo.SetDisplayName(c.Request.Context(), id, name); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not update profile")
		return
	}
	u, err := h.repo.ByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}
