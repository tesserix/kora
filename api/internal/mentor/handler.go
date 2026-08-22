package mentor

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	service Service
}

const maxMentorBodyBytes = 64 << 10

func NewHandler(service Service) Handler { return Handler{service: service} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) commitmentID(c *gin.Context) (uuid.UUID, bool) {
	id, err := ParseCommitmentID(c.Param("id"))
	if err != nil {
		httpx.RespondServiceError(c, err)
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) respond(c *gin.Context, data any, err error) {
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "commitment not found")
		return
	}
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, data)
}

func bindMentorJSON(c *gin.Context, input any, message string) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMentorBodyBytes)
	if err := c.ShouldBindJSON(input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", message)
		return false
	}
	return true
}

func (h Handler) GetProfile(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	profile, err := h.service.Profile(c.Request.Context(), userID)
	h.respond(c, profile, err)
}

func (h Handler) PutProfile(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var input ProfileInput
	if !bindMentorJSON(c, &input, "malformed mentor profile") {
		return
	}
	profile, err := h.service.PutProfile(c.Request.Context(), userID, input)
	h.respond(c, profile, err)
}

func (h Handler) ListHealthDays(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	days, err := h.service.HealthDays(c.Request.Context(), userID, c.Query("from"))
	h.respond(c, days, err)
}

func (h Handler) PutHealthDays(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var input HealthDaysInput
	if !bindMentorJSON(c, &input, "malformed health summary") {
		return
	}
	count, err := h.service.PutHealthDays(c.Request.Context(), userID, input)
	h.respond(c, gin.H{"synced": count}, err)
}

func (h Handler) DeleteHealthDays(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.service.DeleteHealthDays(c.Request.Context(), userID); err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h Handler) ListCommitments(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	items, err := h.service.Commitments(c.Request.Context(), userID)
	h.respond(c, items, err)
}

func (h Handler) PutCommitment(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.commitmentID(c)
	if !ok {
		return
	}
	var input CommitmentInput
	if !bindMentorJSON(c, &input, "malformed commitment") {
		return
	}
	item, err := h.service.PutCommitment(c.Request.Context(), userID, id, input)
	h.respond(c, item, err)
}

func (h Handler) AcceptProposal(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	proposalID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.RespondServiceError(c, validation("proposal id is invalid"))
		return
	}
	var input ProposalAcceptanceInput
	if !bindMentorJSON(c, &input, "malformed proposal acceptance") {
		return
	}
	item, err := h.service.AcceptProposal(c.Request.Context(), userID, proposalID, input)
	h.respond(c, item, err)
}

func (h Handler) PutCheckIn(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.commitmentID(c)
	if !ok {
		return
	}
	var input CheckInInput
	if !bindMentorJSON(c, &input, "malformed check-in") {
		return
	}
	checkIn, err := h.service.PutCheckIn(c.Request.Context(), userID, id, input)
	h.respond(c, checkIn, err)
}
