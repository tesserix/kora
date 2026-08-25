package share

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

// respond maps service errors to status codes. ErrNotOwner is 404 on purpose:
// a 403 would confirm the circle exists.
func respond(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrNotOwner):
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
	case errors.Is(err, ErrNotFriends):
		httpx.Error(c, http.StatusBadRequest, "not_friends", "You can only add friends to a circle.")
	case errors.Is(err, ErrDuplicateName):
		httpx.Error(c, http.StatusConflict, "duplicate_name", "You already have a circle with that name.")
	default:
		httpx.RespondServiceError(c, err)
	}
}

func (h Handler) List(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	views, err := h.svc.List(c.Request.Context(), id)
	if err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, views)
}

// Memberships answers "whose data can I see, and how do I stop it" — the
// mirror of List, and the read path that makes Leave reachable at all
// (kora#440). The member id comes from the authenticated caller only.
func (h Handler) Memberships(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	views, err := h.svc.Memberships(c.Request.Context(), id)
	if err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, views)
}

func (h Handler) Create(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Give the circle a name.")
		return
	}
	circle, err := h.svc.Create(c.Request.Context(), id, req.Name)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": circle})
}

func (h Handler) SetCategories(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	var req struct {
		Categories []access.Category `json:"categories"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Send a list of categories.")
		return
	}
	if err := h.svc.SetCategories(c.Request.Context(), id, circleID, req.Categories); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"categories": req.Categories})
}

func (h Handler) AddMember(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	var req struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Send the friend's user_id.")
		return
	}
	if err := h.svc.AddMember(c.Request.Context(), id, circleID, req.UserID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h Handler) RemoveMember(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	memberID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Member not found.")
		return
	}
	if err := h.svc.RemoveMember(c.Request.Context(), id, circleID, memberID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h Handler) Delete(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	if err := h.svc.Delete(c.Request.Context(), id, circleID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

// Leave removes the AUTHENTICATED CALLER from a circle. The member id comes
// only from user.IDFromContext(c) -- never from the request body, a query parameter, or
// a path segment. share.Service.Leave is deliberately not owner-gated (that's
// its whole purpose: letting someone exit a circle they don't own), so it
// offers no protection of its own. If this handler ever read the member id
// from request input, POST /v1/share/circles/:id/leave would become "remove
// anyone from any circle."
func (h Handler) Leave(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	if err := h.svc.Leave(c.Request.Context(), id, circleID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}
