package coach

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/agents"
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

// budgetDegradedText is shown when a user has exhausted an AI quota window —
// Ask degrades gracefully instead of calling the provider.
const budgetDegradedText = "I've reached your AI usage limit — try again after it resets."

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
	// By names the agent that produced Text. It is zero when the direct
	// provider answered, which the client shows as the plain assistant.
	By Attribution
}

// Attribution is who answered: the agent's published display name and the
// capability the question routed to. Both come from the registry, so a
// republished agent renames itself in the UI without a Kora deploy.
type Attribution struct {
	Agent string
	Skill string
	// ReviewedBy names the agent that reviewed a planner draft before it was
	// shown. Empty on every other path — a plain answer has no review stage.
	ReviewedBy string
}

// guidanceSkill is the registry skill id Q&A routes to. Kora names the
// capability, not the agent: whichever published agent declares this skill
// answers, so adding or replacing one is a registry change, not a deploy.
const guidanceSkill = "nutrition-guidance"

// AgentRunner is the coach's view of the agent path — satisfied by
// *agents.Coordinator. It is an interface here so this package keeps its
// dependencies inverted and can be tested without a registry.
type AgentRunner interface {
	Run(ctx context.Context, skill, prompt string) (agents.Run, error)
}

// Service is the coach's Q&A + nudges entry point: grounded over a
// deterministic Context, budget-gated via ai.Meter, and guardrail-gated via
// the Protective policy.
type Service struct {
	g        *Grounder
	provider ai.Provider
	meter    ai.Meter
	thread   *ThreadRepository
	runner   AgentRunner
}

// NewService builds a Service over its collaborators. thread may be nil, in
// which case exchanges are answered but not persisted.
func NewService(g *Grounder, p ai.Provider, m ai.Meter, thread *ThreadRepository) *Service {
	return &Service{g: g, provider: p, meter: m, thread: thread}
}

// WithAgents returns a copy of s that prefers the registry-resolved agent for
// Q&A. A nil or typed-nil runner leaves the direct provider path in place, so
// an unconfigured registry is simply the previous behaviour.
func (s *Service) WithAgents(runner AgentRunner) *Service {
	if runner == nil || reflect.ValueOf(runner).IsNil() {
		return s
	}
	out := *s
	out.runner = runner
	return &out
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

	if s.provider == nil && s.runner == nil {
		return Answer{Text: providerUnavailableText, ShowSupport: guardrails.AtRisk(signals)}, nil
	}

	ok, err := s.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: check budget: %w", err)
	}
	if !ok {
		return Answer{Text: budgetDegradedText, ShowSupport: guardrails.AtRisk(signals)}, nil
	}

	skill := s.classifySkill(ctx, question)
	userPrompt := fmt.Sprintf("CONTEXT:\n%s\n%s\nQUESTION: %s", grounded.Render(), s.renderHistory(ctx, userID), question)

	by := Attribution{}
	raw, run, err := s.askAgent(ctx, userID, userPrompt, skill)
	if err == nil {
		// The skill is the one Kora asked for, not the one the run echoes
		// back: the capability that routed the question is what the user is
		// told, and it stays right even if a runner omits the field.
		by = Attribution{Agent: run.DisplayName, Skill: skill}
		if skill == planningSkill {
			// Planner drafts are machine-shaped and unvetted; the coach
			// reviews them against the user's numbers and presents the result
			// as a proposal to approve or challenge. A failed review keeps
			// the draft — worse, but still an answer.
			if reviewed, reviewer := s.reviewPlan(ctx, userID, grounded.Render(), question, raw); reviewed != "" {
				raw = reviewed
				by.ReviewedBy = reviewer
			}
		}
	} else {
		// The agent path is preferred, not required: a registry that publishes
		// no matching agent, or a gateway that fails, must not cost the user an
		// answer the direct provider can still give. An unconfigured runner is
		// the expected state in dev and is not worth a line per request.
		if !errors.Is(err, errNoAgent) {
			slog.WarnContext(ctx, "coach: agent run failed, falling back to the provider", "err", err, "skill", skill)
		}
		raw, err = s.askProvider(ctx, userID, userPrompt)
	}
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: generate: %w", err)
	}

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
		By:          by,
	}

	// A storage failure must not lose an answer the user is already owed, so
	// log and continue rather than returning an error.
	if s.thread != nil {
		if err := s.thread.AppendExchange(ctx, userID, question, answer.Text, answer.Citations); err != nil {
			slog.WarnContext(ctx, "coach: failed to persist thread exchange", "err", err, "user_id", userID)
		}
	}

	return answer, nil
}

// historyTurns is how many prior turns are replayed into the prompt. Enough
// for an agent to have asked a clarifying question and to read the answer to
// it; short enough that the grounded CONTEXT stays the dominant input and the
// call stays cheap.
const historyTurns = 8

// renderHistory replays the tail of the user's thread as conversation.
//
// Without it the coach cannot hold a conversation at all: it could ask "what
// does your training week look like?" and then never see the reply, because
// each Ask arrived as an isolated question. Returns "" when there is no
// history, so a first message is shaped exactly as it was before.
//
// Read failures degrade to no history rather than failing the ask — losing
// context is a worse answer, losing the answer is no answer.
func (s *Service) renderHistory(ctx context.Context, userID uuid.UUID) string {
	if s.thread == nil {
		return ""
	}

	turns, err := s.thread.ListRecent(ctx, userID, historyTurns)
	if err != nil {
		slog.WarnContext(ctx, "coach: history read failed, answering without it", "err", err, "user_id", userID)
		return ""
	}
	if len(turns) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("\nCONVERSATION SO FAR:\n")
	for _, t := range turns {
		speaker := "User"
		if t.Role != TurnRoleUser {
			speaker = "You"
		}
		fmt.Fprintf(&b, "%s: %s\n", speaker, t.Text)
	}
	return b.String()
}

// askAgent runs the question through the registry-resolved agent. The agent
// carries its own system prompt and guardrails from its published definition,
// so only the grounded CONTEXT/QUESTION body is sent — the same body the
// direct path uses, which the agents' supervisor grounding already expects.
func (s *Service) askAgent(ctx context.Context, userID uuid.UUID, userPrompt string, skill string) (string, agents.Run, error) {
	if s.runner == nil {
		return "", agents.Run{}, errNoAgent
	}

	started := time.Now()
	run, err := s.runner.Run(ctx, skill, userPrompt)
	usage := ai.Usage{
		Provider:  "agentgateway",
		Model:     run.Agent,
		CallType:  "coach",
		TokensIn:  run.Usage.InputTokens,
		TokensOut: run.Usage.OutputTokens,
		LatencyMs: int(time.Since(started).Milliseconds()),
	}
	if err != nil {
		// A failed run still consumed gateway quota, so it is metered like any
		// other failed provider call rather than dropped.
		usage.Outcome = outcomeFor(err)
		s.record(ctx, userID, usage)
		return "", agents.Run{}, err
	}

	s.record(ctx, userID, usage)
	return run.Text, run, nil
}

// askProvider is the pre-agent path: one grounded GenerateText call.
func (s *Service) askProvider(ctx context.Context, userID uuid.UUID, userPrompt string) (string, error) {
	return s.generate(ctx, userID, qaSystemPrompt, userPrompt)
}

// generate runs one provider call with a task-specific system contract while
// preserving the same abandoned-call accounting as ordinary coach Q&A. Meal
// plan review uses this because review instructions are not the Q&A prompt.
func (s *Service) generate(
	ctx context.Context,
	userID uuid.UUID,
	systemPrompt, userPrompt string,
) (string, error) {
	if s.provider == nil {
		return "", errNoProvider
	}
	providerCtx, collector := ai.WithUsageCollector(ctx)
	raw, usage, err := s.provider.GenerateText(providerCtx, systemPrompt, userPrompt)
	for _, abandoned := range collector.Drain() {
		s.record(ctx, userID, abandoned)
	}
	if err != nil {
		usage.Outcome = outcomeFor(err)
		s.record(ctx, userID, usage)
		return "", err
	}
	s.record(ctx, userID, usage)
	return raw, nil
}

// errNoAgent marks "the agent path is not configured", so the fallback log
// distinguishes it from an agent that was tried and failed.
var errNoAgent = errors.New("coach: no agent runner configured")

// errNoProvider marks the mirror case: the agent path failed and there is no
// direct provider to fall back to.
var errNoProvider = errors.New("coach: no provider configured")

func outcomeFor(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return ai.OutcomeTimeout
	}
	return ai.OutcomeError
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
	if u.Provider == "" && s.provider != nil {
		u.Provider = s.provider.Name()
	}
	if u.Outcome == "" {
		u.Outcome = ai.OutcomeOK
	}
	_ = s.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}
