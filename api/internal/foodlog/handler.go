package foodlog

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc  Service
	repo Repository
}

func NewHandler(svc Service, repo Repository) Handler {
	return Handler{svc: svc, repo: repo}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req LogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed log body")
		return
	}
	log, err := h.svc.LogFood(c.Request.Context(), userID, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": log})
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	day, err := time.Parse("2006-01-02", c.Query("date"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
		return
	}
	logs, err := h.repo.ListByUserAndDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not list logs")
		return
	}
	httpx.OK(c, logs)
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	if err := h.repo.Delete(c.Request.Context(), userID, logID); err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}

type copyDayRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (h Handler) CopyDay(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req copyDayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	from, err1 := time.Parse("2006-01-02", req.From)
	to, err2 := time.Parse("2006-01-02", req.To)
	if err1 != nil || err2 != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "from/to must be YYYY-MM-DD")
		return
	}
	n, err := h.svc.CopyDay(c.Request.Context(), userID, from, to, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not copy day")
		return
	}
	httpx.OK(c, gin.H{"copied": n})
}

type repeatRequest struct {
	At time.Time `json:"at"`
}

func (h Handler) Repeat(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	var req repeatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	at := req.At
	if at.IsZero() {
		at = time.Now()
	}
	log, err := h.svc.RepeatLog(c.Request.Context(), userID, logID, at)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": log})
}
