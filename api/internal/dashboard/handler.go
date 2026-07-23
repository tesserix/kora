package dashboard

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

func NewHandler(svc Service) Handler {
	return Handler{svc: svc}
}

func (h Handler) Get(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	dateStr := c.Query("date")
	day := time.Now().UTC()
	if dateStr != "" {
		parsed, perr := time.Parse("2006-01-02", dateStr)
		if perr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
			return
		}
		day = parsed
	}
	sum, err := h.svc.ForDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not build dashboard")
		return
	}
	httpx.OK(c, sum)
}
