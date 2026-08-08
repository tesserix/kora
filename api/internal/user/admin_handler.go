package user

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// AdminHandler serves the bffauth-protected /v1/admin/users endpoints.
type AdminHandler struct {
	repo Repository
	svc  Service
}

// NewAdminHandler wires the admin user handlers. svc is unused by List; a
// later task's Delete needs it.
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
