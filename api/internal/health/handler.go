// api/internal/health/handler.go
package health

import (
	"log/slog"
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
	// One line per sync, counts only -- never a weight, because this repo is
	// public and these logs get quoted into issues.
	//
	// It exists to make kora#30's relaunch check OBSERVABLE. The device holds
	// an HKAnchoredObjectQuery anchor in AsyncStorage; when it is reused, the
	// client finds no new samples and posts NOTHING, so a healthy re-sync is
	// silence. When the anchor is lost, the client re-sends the user's entire
	// history and weight_entries_hk_uuid_key (unique on user_id, hk_uuid)
	// absorbs every row. The database ends up identical either way -- same
	// row count, same contents -- so "did the anchor survive?" could not be
	// answered from the data at all. received tells the two apart: a line
	// with received > 0 and accepted == 0 is an anchor that did not survive.
	slog.InfoContext(c.Request.Context(), "health: weight sync",
		"user_id", uid,
		"received", len(req.Weights),
		"accepted", resp.Accepted,
		"rejected", len(resp.Rejected))
	httpx.OK(c, resp)
}
