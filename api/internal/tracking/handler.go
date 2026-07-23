package tracking

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	repo  Repository
	users user.Repository
}

func NewHandler(repo Repository, users user.Repository) Handler {
	return Handler{repo: repo, users: users}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	id, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return uuid.Nil, false
	}
	return id, true
}

type addWaterRequest struct {
	VolumeML int       `json:"volume_ml"`
	LoggedAt time.Time `json:"logged_at"`
}

func (h Handler) Add(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req addWaterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	e, err := h.repo.AddWater(c.Request.Context(), userID, req.VolumeML, req.LoggedAt)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": e})
}

func (h Handler) DayTotal(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	day, err := time.Parse("2006-01-02", c.Query("date"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
		return
	}
	total, err := h.repo.WaterTotalForDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not total water")
		return
	}
	httpx.OK(c, gin.H{"volume_ml": total})
}
