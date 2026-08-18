package billing

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Handler exposes the authenticated user's AI quota status.
type Handler struct {
	meter Meter
}

// NewHandler builds a billing Handler over meter.
func NewHandler(meter Meter) Handler {
	return Handler{meter: meter}
}

// UsageStatus returns only the current authenticated user's request windows.
func (h Handler) UsageStatus(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	status, err := h.meter.Status(c.Request.Context(), userID)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, status)
}
