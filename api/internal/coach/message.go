package coach

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// FoodResolver is the capture surface's view of the resolution engine. It is
// declared here, as an interface over an opaque result, so this package can
// dispatch to food resolution without importing it — the result is passed
// straight through to JSON, and its shape stays owned by package resolve.
type FoodResolver interface {
	ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (any, error)
}

// WithFoodResolver returns a copy of h that can also answer with a food
// resolution. Without one, every message is treated as conversation.
func (h Handler) WithFoodResolver(fr FoodResolver) Handler {
	h.food = fr
	return h
}

type messageRequest struct {
	Text string `json:"text"`
}

// Message is the capture composer's single entry point.
//
// It exists because the composer previously posted everything the user typed
// to food resolution, which asks a vision/text model "what foods are in this?"
// — a question with no honest answer for "help me build a meal plan". The
// model duly invented four items and offered to log them. Deciding what a
// message IS has to happen before anything acts on it.
//
// The reply is a tagged union: {"kind":"resolution"} keeps the existing
// confirm-and-log card, {"kind":"answer"} is conversation.
func (h Handler) Message(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAskBodyBytes)

	var req messageRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Text) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "text must be at least 2 characters")
		return
	}

	ctx := c.Request.Context()
	route := h.svc.ClassifyRoute(ctx, req.Text)

	if route == RouteLog && h.food != nil {
		res, err := h.food.ResolveText(ctx, userID, req.Text)
		if err != nil {
			httpx.RespondServiceError(c, err)
			return
		}
		httpx.OK(c, gin.H{"kind": "resolution", "resolution": res})
		return
	}

	answer, err := h.svc.Ask(ctx, userID, time.Now().UTC(), user.LocFromContext(c), req.Text)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}

	cites := answer.Citations
	if cites == nil {
		cites = []Fact{}
	}
	body := gin.H{
		"kind":         "answer",
		"answer":       answer.Text,
		"citations":    cites,
		"show_support": answer.ShowSupport,
	}
	if answer.By.Agent != "" {
		body["agent"] = gin.H{"name": answer.By.Agent, "skill": answer.By.Skill}
	}
	httpx.OK(c, body)
}
