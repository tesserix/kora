package memory

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) Get(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	loc := user.LocFromContext(c)
	mem, err := h.svc.Build(c.Request.Context(), userID, time.Now(), loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, mem)
}
