package compare

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) Get(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	res, err := h.svc.Compare(c.Request.Context(), id, time.Now(), user.LocFromContext(c))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	httpx.OK(c, res)
}
