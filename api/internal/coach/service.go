package coach

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/httpx"
)

// qaSystemPrompt is the strict grounding contract for the coach's Q&A
// answers: answer only from the supplied CONTEXT, never invent a number
// that isn't in it, admit when something isn't covered, and stay additive —
// never steer the user toward eating less.
const qaSystemPrompt = `You are Kora, a supportive nutrition coach. Answer the user's question using ONLY the facts given in CONTEXT below.

Rules:
- Never invent or guess a number that is not explicitly present in CONTEXT.
- If the answer isn't in CONTEXT, say plainly that you don't have that information — never make one up.
- Be additive and encouraging: never tell the user to eat less, restrict, skip meals, or stop eating.
- Keep the answer short and conversational.`

// budgetDegradedText is shown when a user has exhausted their monthly AI
// budget — Ask degrades gracefully instead of calling the provider.
const budgetDegradedText = "I've hit today's usage limit — try again later."

// emptyQuestionMessage is the client-safe message for a blank/whitespace-only
// question, surfaced via httpx.ValidationError so the HTTP layer maps it to
// a 400.
const emptyQuestionMessage = "question is required"

// Answer is the Q&A result: the guardrail-gated text, the grounding facts it
// can be checked against, and whether a supportive resource should also be
// surfaced.
type Answer struct {
	Text        string
	Citations   []Fact
	ShowSupport bool
}

// Service is the coach's Q&A + nudges entry point: grounded over a
// deterministic Context, budget-gated via ai.Meter, and guardrail-gated via
// the Protective policy.
type Service struct {
	g        *Grounder
	provider ai.Provider
	meter    ai.Meter
}

// NewService builds a Service over its collaborators.
func NewService(g *Grounder, p ai.Provider, m ai.Meter) *Service {
	return &Service{g: g, provider: p, meter: m}
}

// Ask answers a free-text question grounded over the user's Context. The
// provider only ever sees the rendered, already-computed Context — it never
// invents nutrition numbers — and its raw answer is gated by the Protective
// guardrails policy before being returned.
func (s *Service) Ask(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location, question string) (Answer, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return Answer{}, httpx.ValidationError{Message: emptyQuestionMessage}
	}

	grounded, err := s.g.BuildContext(ctx, userID, now, loc)
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: build context: %w", err)
	}
	signals := SignalsFrom(grounded)

	ok, err := s.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: check budget: %w", err)
	}
	if !ok {
		return Answer{Text: budgetDegradedText, ShowSupport: guardrails.AtRisk(signals)}, nil
	}

	userPrompt := fmt.Sprintf("CONTEXT:\n%s\n\nQUESTION: %s", grounded.Render(), question)
	raw, usage, err := s.provider.GenerateText(ctx, qaSystemPrompt, userPrompt)
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: generate: %w", err)
	}
	s.record(ctx, userID, usage)

	decision := guardrails.Evaluate(guardrails.Nudge{Text: raw, Restrictive: false}, signals)
	return Answer{
		Text:        decision.Text,
		Citations:   grounded.Facts(),
		ShowSupport: decision.ShowSupport || guardrails.AtRisk(signals),
	}, nil
}

// Nudges is a thin wrapper: build the Context, derive Signals, and run them
// through BuildNudges (which itself gates every candidate via the
// Protective policy).
func (s *Service) Nudges(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (NudgeResult, error) {
	grounded, err := s.g.BuildContext(ctx, userID, now, loc)
	if err != nil {
		return NudgeResult{}, fmt.Errorf("coach: nudges: build context: %w", err)
	}
	return BuildNudges(grounded, SignalsFrom(grounded)), nil
}

// record meters one provider call. Metering failures must never break the
// Q&A response — a user's answer cannot depend on the billing table being
// reachable — so the error is deliberately ignored here, matching
// ai.Resolver.record's rationale.
func (s *Service) record(ctx context.Context, userID uuid.UUID, u ai.Usage) {
	_ = s.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}
