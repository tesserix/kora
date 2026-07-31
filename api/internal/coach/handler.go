package coach

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Handler exposes the coach's nudges and Q&A endpoints over Service.
type Handler struct {
	svc *Service
}

// NewHandler builds a Handler over svc.
func NewHandler(svc *Service) Handler {
	return Handler{svc: svc}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// Nudges returns the guardrail-gated nudges the coach currently has for the
// authenticated user.
func (h Handler) Nudges(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	result, err := h.svc.Nudges(c.Request.Context(), userID, now, loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	logNudgeReasons(c.Request.Context(), userID, result.Nudges)
	httpx.OK(c, gin.H{"nudges": result.Nudges, "show_support": result.ShowSupport})
}

// logNudgeReasons preserves the guardrail audit trail server-side: Reason
// is not serialised to the client (see Nudge.Reason), so this is the only
// place it is recorded now.
func logNudgeReasons(ctx context.Context, userID uuid.UUID, nudges []Nudge) {
	for _, n := range nudges {
		slog.DebugContext(ctx, "coach: nudge decision",
			"user_id", userID, "kind", n.Kind, "reason", n.Reason)
	}
}

// maxAskQuestionChars caps a coach question. A few thousand characters is
// generous for a real nutrition question (multiple paragraphs' worth) while
// still bounding the permanent, unretained growth of coach_turns.text.
const maxAskQuestionChars = 4000

// maxAskBodyBytes is the hard cap applied to the raw request body, ahead of
// JSON parsing, mirroring maxPhotoBodyBytes's role in package resolve. The
// headroom above maxAskQuestionChars covers a maxAskQuestionChars-rune
// question that is entirely multi-byte UTF-8 (worst case 4 bytes/rune) plus
// the small fixed overhead of the JSON wrapper (`{"question":"..."}`) and
// any character escaping.
const maxAskBodyBytes = maxAskQuestionChars*4 + 1<<10

// askRequest is the Ask endpoint's request body. The binding tag's numeral
// must be kept in lockstep with maxAskQuestionChars above (struct tags
// cannot reference a named constant).
type askRequest struct {
	Question string `json:"question" binding:"max=4000"` // must match maxAskQuestionChars
}

// Ask answers a free-text question grounded over the authenticated user's
// Context.
func (h Handler) Ask(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	// Bound the raw body BEFORE JSON parsing so an oversized payload is
	// rejected while streaming in, not after Gin has fully buffered it.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAskBodyBytes)

	var req askRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed request body")
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	answer, err := h.svc.Ask(c.Request.Context(), userID, now, loc, req.Question)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	cites := answer.Citations
	if cites == nil {
		cites = []Fact{}
	}
	httpx.OK(c, gin.H{"answer": answer.Text, "citations": cites, "show_support": answer.ShowSupport})
}

// threadTurnResponse is one replayed turn in the wire format. Field names are
// snake_case because the mobile client codes against them.
type threadTurnResponse struct {
	Role      TurnRole  `json:"role"`
	Text      string    `json:"text"`
	Citations []Fact    `json:"citations"`
	CreatedAt time.Time `json:"created_at"`
}

// Thread replays the authenticated user's stored coach turns.
func (h Handler) Thread(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	result, err := h.svc.Thread(c.Request.Context(), userID, now, loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}

	turns := make([]threadTurnResponse, len(result.Turns))
	for i, t := range result.Turns {
		cites := t.Citations
		if cites == nil {
			cites = []Fact{}
		}
		turns[i] = threadTurnResponse{Role: t.Role, Text: t.Text, Citations: cites, CreatedAt: t.CreatedAt}
	}

	httpx.OK(c, gin.H{"turns": turns, "show_support": result.ShowSupport})
}
