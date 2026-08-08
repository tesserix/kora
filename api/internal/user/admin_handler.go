package user

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/httpx"
)

// AdminHandler serves the bffauth-protected /v1/admin/users endpoints.
type AdminHandler struct {
	repo Repository
	svc  Service
}

// NewAdminHandler wires the admin user handlers. svc is unused by List and
// Get; Delete needs it.
func NewAdminHandler(r Repository, s Service) AdminHandler { return AdminHandler{repo: r, svc: s} }

// List serves GET /v1/admin/users.
func (h AdminHandler) List(c *gin.Context) {
	res, err := h.repo.ListForAdmin(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	httpx.OK(c, res)
}

// Get serves GET /v1/admin/users/:id -- one user's activation row plus the
// preview of what deleting them would destroy and hand over. Counts only.
func (h AdminHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}
	d, err := h.repo.GetForAdmin(c.Request.Context(), id)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	httpx.OK(c, d)
}

// Delete serves DELETE /v1/admin/users/:id. Irreversible; no grace period.
//
// Returns 200 WITH A BODY, not the bare 204 that DELETE /v1/me returns, and
// the body is the whole point. If the Firebase identity survives the
// deletion, the user can still sign in, EnsureUser provisions a fresh row,
// and the person the admin deleted REAPPEARS. A self-deleting user self-heals
// -- they sign in, get an empty row, and delete again -- so /v1/me can stay
// silent. An admin has no such retry path through the user, so the admin must
// be TOLD, along with which groups changed hands. Do not "simplify" this to a
// 204.
func (h AdminHandler) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}
	res, err := h.svc.Delete(c.Request.Context(), id, DeleteActor{
		IsAdmin: true,
		ID:      c.GetString(bffauth.CtxAdminID),
		Email:   c.GetString(bffauth.CtxAdminEmail),
	})
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	httpx.OK(c, res)
}
