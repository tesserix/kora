package coach

import (
	"context"
	"fmt"
	"log/slog"
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

// providerUnavailableText is shown when no ai.Provider is configured (e.g.
// GEMINI_API_KEY unset) — Ask degrades gracefully instead of nil-panicking
// on the provider call.
const providerUnavailableText = "Q&A isn't available right now — try again later."

// emptyQuestionMessage is the client-safe message for a blank/whitespace-only
// question, surfaced via httpx.ValidationError so the HTTP layer maps it to
// a 400.
const emptyQuestionMessage = "question is required"

// suppressedAnswerMessage is returned in place of a raw answer whenever the
// Protective guardrails policy Suppresses it (ED-risk signal present and the
// raw text is restrictive). The prompt already asks the provider not to
// produce this kind of text, but the guardrail is the real backstop, so Ask
// must never fall back to returning empty text here.
const suppressedAnswerMessage = "Let's focus on what you're doing well. If food feels stressful, it can help to talk to someone you trust."

// restrictivePhrases are lowercase substrings that mark a Q&A answer as
// steering the user toward eating less / stopping — the same category the
// system prompt already asks the provider to avoid. looksRestrictive checks
// the raw provider answer against this list so guardrails.Evaluate is
// actually able to Soften/Suppress restrictive answer text instead of always
// receiving Restrictive: false.
var restrictivePhrases = []string{
	"eat less",
	"eaten enough",
	"you've had enough",
	"stop eating",
	"skip a meal",
	"skip meals",
	"cut back",
	"restrict",
	"too many calories",
	"go to bed hungry",
}

// looksRestrictive reports whether text contains any restrictivePhrases,
// case-insensitively. It is a pure heuristic over the raw provider answer —
// no signals, no side effects — used to gate the answer through the
// Protective guardrails policy for real.
func looksRestrictive(text string) bool {
	lower := strings.ToLower(text)
	for _, phrase := range restrictivePhrases {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

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
	thread   *ThreadRepository
}

// NewService builds a Service over its collaborators. thread may be nil, in
// which case exchanges are answered but not persisted.
func NewService(g *Grounder, p ai.Provider, m ai.Meter, thread *ThreadRepository) *Service {
	return &Service{g: g, provider: p, meter: m, thread: thread}
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

	if s.provider == nil {
		return Answer{Text: providerUnavailableText, ShowSupport: guardrails.AtRisk(signals)}, nil
	}

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

	restrictive := looksRestrictive(raw)
	decision := guardrails.Evaluate(guardrails.Nudge{Text: raw, Restrictive: restrictive}, signals)

	text := decision.Text
	if decision.Action == guardrails.Suppress {
		// Suppress means Decision.Text is "" — never surface an empty
		// answer, fall back to a safe supportive message instead.
		text = suppressedAnswerMessage
	}

	answer := Answer{
		Text:        text,
		Citations:   grounded.Facts(),
		ShowSupport: decision.ShowSupport || guardrails.AtRisk(signals),
	}

	// Store the exchange for replay only; prior turns are never fed back
	// into the prompt. A storage failure must not lose an answer the user
	// is already owed, so log and continue rather than returning an error.
	if s.thread != nil {
		if err := s.thread.AppendExchange(ctx, userID, question, answer.Text, answer.Citations); err != nil {
			slog.WarnContext(ctx, "coach: failed to persist thread exchange", "err", err, "user_id", userID)
		}
	}

	return answer, nil
}

// ThreadResult is a replayed thread plus the CURRENT support state.
type ThreadResult struct {
	Turns       []StoredTurn
	ShowSupport bool
}

// Thread replays the user's stored turns. ShowSupport is recomputed from the
// user's current signals rather than stored per turn: a stale risk flag must
// not reappear, and a cleared one must not persist. Otto turns are also
// re-gated against the CURRENT Protective policy before being returned: a
// stored answer must not bypass a guardrail that would suppress or soften it
// today, even though it was fine to show at write time (e.g. the user has
// since become at-risk, or the restrictive-phrase lexicon has since been
// broadened). This is a pure read-time transform — the rows returned by
// ListRecent, and the database, are never mutated.
func (s *Service) Thread(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (ThreadResult, error) {
	grounded, err := s.g.BuildContext(ctx, userID, now, loc)
	if err != nil {
		return ThreadResult{}, fmt.Errorf("coach: thread: build context: %w", err)
	}
	signals := SignalsFrom(grounded)

	turns := []StoredTurn{}
	if s.thread != nil {
		turns, err = s.thread.ListRecent(ctx, userID, maxThreadTurns)
		if err != nil {
			return ThreadResult{}, fmt.Errorf("coach: thread: list turns: %w", err)
		}
	}

	return ThreadResult{Turns: regateStoredTurns(turns, signals), ShowSupport: guardrails.AtRisk(signals)}, nil
}

// regateStoredTurns re-applies the current Protective policy to every Otto
// turn in turns, returning a new slice — the input is never mutated, per
// this repo's immutability convention, and neither is the underlying stored
// row. User turns are returned as-is: a user's own words are never
// rewritten, only what Otto said is subject to the guardrail.
func regateStoredTurns(turns []StoredTurn, signals guardrails.Signals) []StoredTurn {
	out := make([]StoredTurn, len(turns))
	for i, t := range turns {
		if t.Role != TurnRoleOtto {
			out[i] = t
			continue
		}

		restrictive := looksRestrictive(t.Text)
		decision := guardrails.Evaluate(guardrails.Nudge{Text: t.Text, Restrictive: restrictive}, signals)

		text := decision.Text
		if decision.Action == guardrails.Suppress {
			// Suppress means Decision.Text is "" — never surface an empty
			// answer, fall back to the same safe supportive message Ask uses.
			text = suppressedAnswerMessage
		}

		out[i] = StoredTurn{Role: t.Role, Text: text, CreatedAt: t.CreatedAt, Citations: t.Citations}
	}
	return out
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
//
// Mirrors ai.Resolver.record's Outcome defaulting: a provider that succeeded
// without setting Usage.Outcome (e.g. providers/gemini.go, which never sets
// it) must still be recorded as "ok" — not left blank, which the meter
// normalizes to "other" and hides from every {outcome="ok"} product query.
func (s *Service) record(ctx context.Context, userID uuid.UUID, u ai.Usage) {
	if u.Outcome == "" {
		u.Outcome = ai.OutcomeOK
	}
	_ = s.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}
