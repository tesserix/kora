package coach

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/diet"
	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/mentor"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// qaSystemPrompt is the strict grounding contract for the coach's Q&A
// answers: answer only from the supplied CONTEXT, never invent a number
// that isn't in it, admit when something isn't covered, and stay additive —
// never steer the user toward eating less.
const qaSystemPrompt = `You are Kora, a supportive nutrition coach. Answer the user's question using ONLY the facts given in CONTEXT below.

Rules:
- Never invent or guess a number that is not explicitly present in CONTEXT.
- If the answer isn't in CONTEXT, say plainly that you don't have that information — never make one up.
- After each factual claim that uses a supplied fact, append its exact marker as [cite:fact_id]. Cite only facts used in the answer and never invent a fact_id.
- Be additive and encouraging: never tell the user to eat less, restrict, skip meals, or stop eating.
- Keep the answer short and conversational.`

// budgetDegradedText is shown when a user has exhausted an AI quota window —
// Ask degrades gracefully instead of calling the provider.
const budgetDegradedText = "I've reached your AI usage limit — try again after it resets."

// providerUnavailableText is shown when no ai.Provider is configured (e.g.
// GEMINI_API_KEY unset) — Ask degrades gracefully instead of nil-panicking
// on the provider call.
const providerUnavailableText = "Q&A isn't available right now — try again later."

const planReviewUnavailableText = "I drafted your plan, but I couldn't complete its nutrition review. Please try again — no unreviewed plan was saved."

const planTimeoutText = "Planning took longer than I'm allowed to keep you waiting. Please try again — nothing was saved."

// The planner and its reviewer share one deadline that ends before the mobile
// client's 90s AGENT_REQUEST_TIMEOUT_MS, and the reviewer always keeps its reserve.
const (
	defaultAgentDeadline = 80 * time.Second
	defaultReviewReserve = 30 * time.Second
)

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

var (
	citationMarkerPattern = regexp.MustCompile(`(?i)\[cite:([a-z0-9_]{1,64})\]`)
	citationLikePattern   = regexp.MustCompile(`(?i)\[cite:[^\]\r\n]{0,128}\]`)
)

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
	Proposal    *mentor.CommitmentProposal
	// Plan is the reviewed meal plan in its structured form, so the client
	// can render an approvable card next to the prose that justifies it.
	Plan *PlanProposal
	// By names the agent that produced Text. It is zero when the direct
	// provider answered, which the client shows as the plain assistant.
	By Attribution
	// DietFlags are the user's flagging rules this answer touches. Blocking
	// rules never reach here — they are retried, and failing that replaced.
	DietFlags []diet.Violation
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

// fallbackAgentName is who the thread credits when no published agent
// answered. An unattributed reply is the misleading case: it reads as if the
// registry's coach wrote it, so the app's own persona says otherwise.
const fallbackAgentName = "Otto"

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
	g          *Grounder
	provider   ai.Provider
	meter      ai.Meter
	thread     *ThreadRepository
	runner     AgentRunner
	references NutritionReferenceSource

	agentDeadline time.Duration
	reviewReserve time.Duration
}

// WithNutritionReferences returns a copy that augments each answer with a
// bounded pgvector retrieval over reviewed national food datasets.
func (s *Service) WithNutritionReferences(source NutritionReferenceSource) *Service {
	if source == nil {
		return s
	}
	out := *s
	out.references = source
	return &out
}

// NewService builds a Service over its collaborators. thread may be nil, in
// which case exchanges are answered but not persisted.
func NewService(g *Grounder, p ai.Provider, m ai.Meter, thread *ThreadRepository) *Service {
	return &Service{
		g: g, provider: p, meter: m, thread: thread,
		agentDeadline: defaultAgentDeadline, reviewReserve: defaultReviewReserve,
	}
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
	if s.references != nil {
		items, usage, referenceErr := s.references.Search(
			ctx, question, nutrition.LocaleFromTimezone(loc.String()), nutritionReferenceLimit,
			diet.BlockedTags(grounded.DietProfile),
		)
		if referenceErr != nil {
			usage.Outcome = outcomeFor(referenceErr)
			s.record(ctx, userID, usage)
			slog.WarnContext(ctx, "coach: nutrition reference retrieval failed, answering without it", "err", referenceErr)
		} else {
			s.record(ctx, userID, usage)
			grounded.NutritionReferences = items
		}
	}

	skill := s.classifySkill(ctx, question)
	userPrompt, trimmed := agentPrompt(grounded.Render(), s.renderHistory(ctx, userID), question)
	if trimmed {
		slog.InfoContext(ctx, "coach: prompt trimmed to the agent limit", "user_id", userID)
	}

	by := Attribution{}
	var proposal *mentor.CommitmentProposal
	var plan *PlanProposal
	viaAgent := true
	agentCtx, plannerCtx := ctx, ctx
	if skill == planningSkill {
		var cancelAgent, cancelPlanner context.CancelFunc
		agentCtx, cancelAgent = context.WithTimeout(ctx, s.agentDeadline)
		defer cancelAgent()
		plannerCtx, cancelPlanner = context.WithTimeout(agentCtx, s.agentDeadline-s.reviewReserve)
		defer cancelPlanner()
	}
	raw, run, err := s.askAgent(plannerCtx, userID, userPrompt, skill)
	if err != nil && skill == planningSkill && plannerCtx.Err() != nil && ctx.Err() == nil {
		// An unfinished draft is never reviewed or shown; degrade like a failed review.
		slog.WarnContext(ctx, "coach: meal planner exceeded its deadline", "err", err)
		raw, err = planTimeoutText, nil
	} else if err == nil {
		// The skill is the one Kora asked for, not the one the run echoes
		// back: the capability that routed the question is what the user is
		// told, and it stays right even if a runner omits the field.
		by = Attribution{Agent: run.DisplayName, Skill: skill}
		if skill == planningSkill {
			// Planner drafts are machine-shaped and unvetted; the coach
			// reviews them against the user's numbers and presents the result
			// as a proposal to approve or challenge. A failed review must not
			// expose or persist a draft that has not passed this boundary.
			if reviewed, reviewer := s.reviewPlan(agentCtx, userID, grounded.Render(), question, raw); reviewed != "" {
				by.ReviewedBy = reviewer
				reviewed, envelope, hasReviewedPlan := parseReviewedPlan(reviewed)
				reviewed, proposal = parseReviewedCommitment(reviewed, userID, now, loc, by.Agent, reviewer)
				if !hasReviewedPlan && proposal == nil {
					// A supervisor decision is machine-verifiable or it is not a
					// decision. Never present free-form review prose as though the
					// user had a complete plan or schedulable commitment to approve.
					raw = planReviewUnavailableText
				} else {
					raw = reviewed
					if hasReviewedPlan {
						plan = newPlanProposal(userID, envelope, by.Agent, by.ReviewedBy)
					}
				}
			} else {
				raw = planReviewUnavailableText
			}
			raw = formatPlanDraft(raw)
		}
	} else if !errors.Is(err, errNoAgent) {
		return Answer{}, fmt.Errorf("coach: ask: agent: %w", err)
	} else {
		viaAgent = false
		raw, err = s.askProvider(ctx, userID, userPrompt)
	}
	if err != nil {
		return Answer{}, fmt.Errorf("coach: ask: generate: %w", err)
	}

	// The prompt already carries the user's constraints, but a prompt is
	// guidance. This is the gate that decides what the user actually sees.
	screened, dietFlags, _ := s.screenDiet(ctx, userID, grounded.DietProfile, userPrompt, skill, raw, viaAgent)
	if screened != raw {
		// The proposal and the plan were parsed out of the text the screen just
		// replaced, so they describe food the user is no longer being shown.
		proposal = nil
		plan = nil
	}
	raw = screened

	restrictive := looksRestrictive(raw)
	decision := guardrails.Evaluate(guardrails.Nudge{Text: raw, Restrictive: restrictive}, signals)

	text := decision.Text
	if decision.Action == guardrails.Suppress {
		// Suppress means Decision.Text is "" — never surface an empty
		// answer, fall back to a safe supportive message instead.
		text = suppressedAnswerMessage
		proposal = nil
		plan = nil
	}
	text, citations := citedFacts(text, grounded.Facts())
	if decision.Action == guardrails.Suppress {
		citations = []Fact{}
	}

	answer := Answer{
		Text:        text,
		Citations:   citations,
		ShowSupport: decision.ShowSupport || guardrails.AtRisk(signals),
		By:          by,
		Proposal:    proposal,
		Plan:        plan,
		DietFlags:   dietFlags,
	}

	// A storage failure must not lose an answer the user is already owed, so
	// log and continue rather than returning an error.
	if s.thread != nil {
		attachments := Attachments{Commitment: answer.Proposal, Plan: answer.Plan}
		if err := s.thread.AppendExchange(ctx, userID, question, answer.Text, answer.Citations, attachments); err != nil {
			slog.WarnContext(ctx, "coach: failed to persist thread exchange", "err", err, "user_id", userID)
			answer.Proposal = nil
			answer.Plan = nil
		}
	} else {
		// Nothing was stored, so nothing has an id the user could approve.
		answer.Proposal = nil
		answer.Plan = nil
	}

	return answer, nil
}

// citedFacts removes model citation markers from user-visible text and
// returns only facts whose exact IDs were cited. Unknown IDs are discarded,
// so prompt injection cannot manufacture evidence that was not supplied.
func citedFacts(text string, facts []Fact) (string, []Fact) {
	byLabel := make(map[string]Fact, len(facts))
	for _, fact := range facts {
		byLabel[strings.ToLower(fact.Label)] = fact
	}

	citations := make([]Fact, 0)
	seen := make(map[string]struct{})
	for _, match := range citationMarkerPattern.FindAllStringSubmatch(text, -1) {
		label := strings.ToLower(match[1])
		fact, ok := byLabel[label]
		if !ok {
			continue
		}
		if _, duplicate := seen[label]; duplicate {
			continue
		}
		seen[label] = struct{}{}
		citations = append(citations, fact)
	}

	clean := citationLikePattern.ReplaceAllString(text, "")
	for _, punctuation := range []string{".", ",", ";", ":", "!", "?"} {
		clean = strings.ReplaceAll(clean, " "+punctuation, punctuation)
	}
	for strings.Contains(clean, "  ") {
		clean = strings.ReplaceAll(clean, "  ", " ")
	}
	return strings.TrimSpace(clean), citations
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
	b.WriteString(historyHeader)
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
		// The A2A envelope tells us when its own token counts are a guess
		// (agents.Usage.Estimated, read in gateway.go); ai.Usage has to carry
		// that through instead of discarding it, or a downstream agent's
		// estimate would masquerade as a measurement once it lands here.
		Estimated: run.Usage.Estimated,
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

// errNoAgent marks "the agent path is not configured", which permits direct
// provider mode for local environments without a Registry-backed runner.
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
		proposal := t.Proposal
		plan := t.Plan
		if decision.Action == guardrails.Suppress {
			// Suppress means Decision.Text is "" — never surface an empty
			// answer, fall back to the same safe supportive message Ask uses.
			text = suppressedAnswerMessage
			proposal = nil
			plan = nil
		}

		out[i] = StoredTurn{
			Role: t.Role, Text: text, CreatedAt: t.CreatedAt,
			Citations: t.Citations, Proposal: proposal, Plan: plan,
		}
	}
	return out
}

// AcceptPlan records the user's approval of one of their plan proposals. A
// service with no thread repository has no proposals to approve, so the id is
// unknown by definition rather than a 500.
func (s *Service) AcceptPlan(ctx context.Context, userID, planID uuid.UUID, now time.Time) (PlanProposal, error) {
	if s.thread == nil {
		return PlanProposal{}, ErrPlanNotFound
	}
	return s.thread.AcceptPlan(ctx, userID, planID, now)
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
	// A run that hit its deadline still spent quota, so metering outlives it.
	_ = s.meter.Record(context.WithoutCancel(ctx), userID, u, ai.EstimateCostUSD(u))
}
