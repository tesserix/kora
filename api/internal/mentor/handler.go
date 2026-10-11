package mentor

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/diet"
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
	h.respondWith(c, data, err, "commitment not found")
}

// respondWith is respond with an accurate not-found message: a missing dietary
// rule reported as a missing commitment sends the client looking in the wrong place.
func (h Handler) respondWith(c *gin.Context, data any, err error, notFound string) {
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", notFound)
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

// ListFoodRules returns every rule with the taxonomy the client offers when
// adding one, so the picker cannot drift from what the server will accept.
func (h Handler) ListFoodRules(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	rules, err := h.service.FoodRules(c.Request.Context(), userID)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"rules":    rules,
		"subjects": diet.Catalog(),
		"patterns": diet.Patterns(),
	})
}

type foodRulesInput struct {
	Rules []FoodRuleInput `json:"rules"`
}

func (h Handler) PutFoodRules(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var input foodRulesInput
	if !bindMentorJSON(c, &input, "malformed dietary rules") {
		return
	}
	rules, err := h.service.PutFoodRules(c.Request.Context(), userID, input.Rules)
	h.respond(c, rules, err)
}

// ConfirmFoodRule puts a proposed rule in force — the one-tap accept for a rule
// Kora inferred from a diet pattern, a profile note, or something said in chat.
func (h Handler) ConfirmFoodRule(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	rule, err := h.service.ConfirmFoodRule(c.Request.Context(), userID, c.Param("subject"))
	h.respondWith(c, rule, err, "dietary rule not found")
}

func (h Handler) DeleteFoodRule(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.service.DeleteFoodRule(c.Request.Context(), userID, c.Param("subject")); err != nil {
		h.respondWith(c, nil, err, "dietary rule not found")
		return
	}
	c.Status(http.StatusNoContent)
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
