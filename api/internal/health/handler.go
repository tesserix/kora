// api/internal/health/handler.go
package health

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

// Sync ingests one batch of platform health records.
//
// Always 200 when the BODY parses, even with every record rejected: the
// per-record verdicts are the payload, and a non-2xx would make the device
// treat a batch of bad samples as a transport failure and re-send it forever.
func (h Handler) Sync(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req SyncRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "body must be a sync request")
		return
	}
	resp, err := h.svc.Sync(c.Request.Context(), uid, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, resp)
}
