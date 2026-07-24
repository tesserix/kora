package nutrition

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

func (h Handler) Search(c *gin.Context) {
	q := c.Query("q")
	if len(q) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "q must be at least 2 characters")
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	candidates, err := h.repo.Resolve(c.Request.Context(), q, nil, limit)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "search failed")
		return
	}
	httpx.OK(c, candidates)
}
