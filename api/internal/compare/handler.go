package compare

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc       Service
	accessSvc access.Service
}

func NewHandler(svc Service, accessSvc access.Service) Handler {
	return Handler{svc: svc, accessSvc: accessSvc}
}

func (h Handler) Get(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	members, err := h.svc.Friends(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	ownerIDs := make([]uuid.UUID, len(members))
	for i, m := range members {
		ownerIDs[i] = m.ID
	}
	grants, err := h.accessSvc.ResolveMany(c.Request.Context(), id, ownerIDs, access.CategoryProgress)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	res, err := h.svc.Compare(c.Request.Context(), id, time.Now(), user.LocFromContext(c), members, grants)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	httpx.OK(c, res)
}
