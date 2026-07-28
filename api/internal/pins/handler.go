package pins

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	pins, err := h.svc.List(c.Request.Context(), userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not list pins")
		return
	}
	httpx.OK(c, pins)
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req CreatePinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed pin body")
		return
	}
	pf, err := h.svc.Create(c.Request.Context(), userID, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": pf})
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	foodItemID, err := uuid.Parse(c.Param("foodItemId"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid food id")
		return
	}
	if err := h.svc.Delete(c.Request.Context(), userID, foodItemID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not unpin")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}
