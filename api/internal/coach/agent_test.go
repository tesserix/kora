package coach

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/tracking"
)

// fakeRunner stands in for *agents.Coordinator, recording the skill it was
// asked for and the prompt it received.
type fakeRunner struct {
	run    agents.Run
	err    error
	calls  int
	skill  string
	prompt string

	// Per-skill behaviour for the two-stage plan path, where one Ask reaches
	// the runner twice (planner drafts, coach reviews). Nil falls back to the
	// single run/err pair above.
	bySkill map[string]agents.Run
	errBy   map[string]error
	skills  []string
	prompts []string
}

func (f *fakeRunner) Run(_ context.Context, skill, prompt string) (agents.Run, error) {
	f.calls++
	f.skill, f.prompt = skill, prompt
	f.skills = append(f.skills, skill)
	f.prompts = append(f.prompts, prompt)
	if f.errBy != nil {
		if err, ok := f.errBy[skill]; ok {
			return agents.Run{}, err
		}
	}
	if f.bySkill != nil {
		return f.bySkill[skill], nil
	}
	return f.run, f.err
}

func askFixture(t *testing.T) (*Grounder, *stubMeter) {
	t.Helper()
	db := testDB(t)
	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	g := NewGrounder(dashSvc, logRepo, memory.NewService(logRepo), fakeWeightSource{})
	return &g, &stubMeter{withinBudget: true}
}

func TestAsk_PrefersTheRegisteredAgentOverTheProvider(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "from the provider"}
	runner := &fakeRunner{run: agents.Run{
		Agent: "nutrition-coach",
		State: "completed",
		Text:  "You have 55g protein to go.",
		Usage: agents.Usage{InputTokens: 120, OutputTokens: 40},
	}}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, "You have 55g protein to go.", a.Text, "the agent's answer must be the one returned")
	require.Equal(t, 1, runner.calls)
	// One provider call, and it is the intent classifier — never the answer.
	// The agent path still owes the user its own text, which is what a.Text
	// asserts above.
	require.Equal(t, 1, provider.calls, "the provider is called to route, not to answer")
	require.Equal(t, guidanceSkill, runner.skill, "Kora routes on a skill, never on an agent name")
	require.Contains(t, runner.prompt, "QUESTION: how's my protein?", "the agent must receive the grounded prompt")
	require.Contains(t, runner.prompt, "CONTEXT:")
}

func TestAsk_MetersTheAgentRunAgainstTheUsersBudget(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{run: agents.Run{
		Agent: "nutrition-coach",
		State: "completed",
		Text:  "You have 55g protein to go.",
		Usage: agents.Usage{InputTokens: 120, OutputTokens: 40},
	}}
	svc := NewService(g, &fakeProvider{}, meter, nil).WithAgents(runner)

	_, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.Len(t, meter.records, 1, "an agent run costs gateway tokens and must be metered like any other call")
	require.Equal(t, "agentgateway", meter.records[0].Provider)
	require.Equal(t, "coach", meter.records[0].CallType)
	require.Equal(t, 120, meter.records[0].TokensIn)
	require.Equal(t, ai.OutcomeOK, meter.records[0].Outcome)
}

// TestAsk_PreservesEstimatedFlagFromAgentUsage pins kora#376's agents-side
// fix: the A2A envelope already tells us when its token counts are a guess
// (agents.Usage.Estimated, read in gateway.go), but that used to be dropped
// on the floor when mapping onto ai.Usage in askAgent — ai.Usage had no
// field to carry it. Now it must survive into what gets metered.
func TestAsk_PreservesEstimatedFlagFromAgentUsage(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{run: agents.Run{
		Agent: "nutrition-coach",
		State: "completed",
		Text:  "You have 55g protein to go.",
		Usage: agents.Usage{InputTokens: 120, OutputTokens: 40, Estimated: true},
	}}
	svc := NewService(g, &fakeProvider{}, meter, nil).WithAgents(runner)

	_, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.Len(t, meter.records, 1)
	require.True(t, meter.records[0].Estimated, "the agent's own Estimated flag must survive the ai.Usage mapping")
}

func TestAsk_FailsClosedWhenTheConfiguredAgentFails(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{
		text:      "from the provider",
		textUsage: ai.Usage{Provider: "stub", CallType: "coach"},
	}
	runner := &fakeRunner{err: errors.New("gateway unreachable")}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	_, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.ErrorContains(t, err, "gateway unreachable")
	// The provider classifies the skill before the agent run. It must not then
	// answer outside the Registry-resolved agent path.
	require.Equal(t, 1, provider.calls)
	require.Len(t, meter.records, 1, "only the failed agent run is metered")
	require.Equal(t, ai.OutcomeError, meter.records[0].Outcome)
}

func TestAsk_AgentAnswersWhenNoProviderIsConfigured(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{run: agents.Run{Agent: "nutrition-coach", State: "completed", Text: "You have 55g protein to go."}}
	svc := NewService(g, nil, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.Equal(t, "You have 55g protein to go.", a.Text, "a configured agent must answer even with no direct provider")
}

func TestAsk_TypedNilRunnerLeavesTheProviderPath(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "from the provider"}
	// main() passes a *agents.Coordinator that is nil when the registry is
	// unconfigured; stored in an interface it is non-nil, which would panic on
	// the first call if WithAgents did not unwrap it.
	var coordinator *agents.Coordinator
	svc := NewService(g, provider, meter, nil).WithAgents(coordinator)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.Equal(t, "from the provider", a.Text)
	require.Equal(t, 1, provider.calls)
}

func TestAsk_AttributesTheAnswerToTheAgentThatProducedIt(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{run: agents.Run{
		Agent:       "nutrition-coach",
		DisplayName: "Nutrition Coach",
		State:       "completed",
		Text:        "You have 55g protein to go.",
	}}
	svc := NewService(g, &fakeProvider{text: "from the provider"}, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, "Nutrition Coach", a.By.Agent, "the user must be shown who answered")
	require.Equal(t, guidanceSkill, a.By.Skill)
	_ = db
}

// An A2A failure must remain visible instead of being masked by a plain model
// answer that skipped the Registry-resolved agent.
func TestAsk_DoesNotMaskAnA2AFailureWithAProviderAnswer(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{err: errors.New("agents: a2a returned 502")}
	provider := &fakeProvider{text: "from the provider"}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	_, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how's my protein?")

	require.ErrorContains(t, err, "agents: a2a returned 502")
	require.Equal(t, 1, provider.calls, "the provider may classify the request but must not answer it")
	_ = db
}

// TestAsk_RoutesAPlanRequestToThePlanningCapability is the regression for the
// bug this routing exists to kill: "create a meal plan for next week" was sent
// to food identification and came back as four items to confirm and log, as
// though the user had eaten a plan they had asked to be written.
//
// Kora names the capability, never the agent — the registry's Meal Planner
// card declares plan-meals today, and replacing it must not need a deploy.
func TestAsk_RoutesAPlanRequestToThePlanningCapability(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	// The classifier is a provider call; this stub answers it with "plan".
	provider := &fakeProvider{text: "plan"}
	runner := &fakeRunner{run: agents.Run{
		Agent:       "meal-planner",
		DisplayName: "Kora Meal Planner",
		State:       "completed",
		Text:        "Here is a seven-day plan.",
	}}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"can you create a proper meal plan for the next 1 week to help me reduce my fat")

	require.NoError(t, err)
	require.Equal(t, planningSkill, runner.skills[0], "a plan request must route to the planning capability")
	require.Equal(t, "Kora Meal Planner", a.By.Agent, "the user is told which agent answered")
	require.Equal(t, planningSkill, a.By.Skill)
	_ = db
}

// The planner speaks JSON — its card's contract is a machine plan — and that
// draft must never reach the user raw. The supervisor reviews it against the
// user's numbers and presents it, and the user is told both names.
func TestAsk_APlanDraftIsReviewedByTheSupervisor(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "plan"}
	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent:       "meal-planner",
			DisplayName: "Kora Meal Planner",
			State:       "completed",
			Text:        `{"summary":"fits your targets","days":[]}`,
		},
		planReviewSkill: {
			Agent:       "plan-supervisor",
			DisplayName: "Kora Plan Supervisor",
			State:       "completed",
			Text: `I checked the draft against your grounded context. Approve, or tell me what to change.
[[KORA_REVIEWED_PLAN]]
{"summary":"Reviewed plan","days":[{"date":"Any day label","meals":[{"name":"Oats","description":"Reviewed breakfast","preparation":"Simmer oats until creamy."}]}]}
[[/KORA_REVIEWED_PLAN]]`,
		},
	}}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals for the week")

	require.NoError(t, err)
	require.Equal(t, []string{planningSkill, planReviewSkill}, runner.skills, "the draft goes to the supervisor for review")
	require.Contains(t, runner.prompts[1], `{"summary":"fits your targets"`, "the reviewer sees the draft")
	require.NotContains(t, runner.prompts[1], "You are the user's nutrition coach",
		"the published supervisor owns its system instructions; Kora sends only review input")
	require.Contains(t, a.Text, "Approve, or tell me what to change", "the user reads the review, not the draft")
	require.Equal(t, "Kora Meal Planner", a.By.Agent)
	require.Equal(t, "Kora Plan Supervisor", a.By.ReviewedBy)
	_ = db
}

func TestAsk_AReviewedRoutineReturnsAndPersistsAUserReviewProposal(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)
	provider := &fakeProvider{text: "plan"}
	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent: "meal-planner", DisplayName: "Kora Meal Planner",
			State: "completed", Text: `{"summary":"hydration rhythm"}`,
		},
		planReviewSkill: {
			Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor",
			State: "completed", Text: `This is a gentle rhythm. Review it before activation.
[[KORA_COMMITMENT]]
{"title":"Drink water","kind":"hydration","cadence":"interval","weekdays_mask":127,"start_minute":480,"interval_minutes":120,"end_minute":1200}
[[/KORA_COMMITMENT]]`,
		},
	}}
	thread := NewThreadRepository(db)
	svc := NewService(g, provider, meter, &thread).WithAgents(runner)

	answer, err := svc.Ask(
		context.Background(), userID,
		time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC),
		time.UTC, "remind me to drink water every two hours",
	)

	require.NoError(t, err)
	require.Equal(t, "This is a gentle rhythm. Review it before activation.", answer.Text)
	require.NotNil(t, answer.Proposal)
	require.Equal(t, "Drink water", answer.Proposal.Title)
	turns, err := thread.ListRecent(t.Context(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)
	require.NotNil(t, turns[1].Proposal)
	require.Equal(t, answer.Proposal.ID, turns[1].Proposal.ID)
}

// A review that cannot happen must not bypass the published supervisor or
// expose the planner's prose as though it had passed.
func TestAsk_AFailedSupervisorReviewDoesNotBypassRegistry(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "plan"}
	runner := &fakeRunner{
		bySkill: map[string]agents.Run{
			planningSkill: {
				Agent:       "meal-planner",
				DisplayName: "Kora Meal Planner",
				State:       "completed",
				Text:        "Day 1: oats. Day 2: eggs.",
			},
		},
		errBy: map[string]error{planReviewSkill: errors.New("gateway unreachable")},
	}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals for the week")

	require.NoError(t, err)
	require.Equal(t, planReviewUnavailableText, a.Text)
	require.NotContains(t, a.Text, "oats")
	require.Equal(t, "Kora Meal Planner", a.By.Agent)
	require.Empty(t, a.By.ReviewedBy)
	require.Nil(t, a.Plan)
	require.Equal(t, 1, provider.calls, "only intent classification may use the provider when the supervisor is configured")
	_ = db
}

// The complement: an ordinary question must NOT be handed to the planner.
func TestAsk_RoutesAPlainQuestionToGuidance(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "ask"}
	runner := &fakeRunner{run: agents.Run{
		Agent:       "nutrition-coach",
		DisplayName: "Kora Nutrition Coach",
		State:       "completed",
		Text:        "You have 55g to go.",
	}}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	_, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "is brown rice better than white?")

	require.NoError(t, err)
	require.Equal(t, guidanceSkill, runner.skill)
	_ = db
}

// A classifier that fails must still produce an answer, routed to guidance.
func TestAsk_ClassifierFailureFallsBackToGuidance(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{run: agents.Run{
		Agent:       "nutrition-coach",
		DisplayName: "Kora Nutrition Coach",
		State:       "completed",
		Text:        "Still answered.",
	}}
	svc := NewService(g, &errorProvider{}, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "plan my week")

	require.NoError(t, err, "a routing failure must not cost the user an answer")
	require.Equal(t, guidanceSkill, runner.skill)
	require.Equal(t, "Still answered.", a.Text)
	_ = db
}

// A planner draft is not safe to show until the nutrition coach has reviewed
// it against the user's constraints. If both review paths fail, fail closed
// with a retryable message rather than presenting an unreviewed plan.
func TestAsk_AnUnreviewedPlanDraftIsNotShown(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{text: "plan", textErrAfter: 1}
	runner := &fakeRunner{
		bySkill: map[string]agents.Run{
			planningSkill: {
				Agent:       "meal-planner",
				DisplayName: "Kora Meal Planner",
				State:       "completed",
				Text:        `{"summary":"High-protein dinners.","days":[{"date":"Day 1","meals":[{"name":"Dinner: Steak","description":"180g sirloin."}]}]}`,
			},
		},
		errBy: map[string]error{planReviewSkill: errors.New("gateway timeout")},
	}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my dinner for tonight")

	require.NoError(t, err)
	require.Equal(t, "I drafted your plan, but I couldn't complete its nutrition review. Please try again — no unreviewed plan was saved.", a.Text)
	require.NotContains(t, a.Text, "High-protein dinners.")
	require.NotContains(t, a.Text, "Steak")
	require.Empty(t, a.By.ReviewedBy, "an unreviewed draft claims no reviewer")
	require.Nil(t, a.Proposal)
	require.Nil(t, a.Plan)
	_ = db
}

// The review stage turns the planner's JSON into prose, which is what the user
// reads — but prose is not something a client can render an approve button on.
// The reviewer's final structured plan is kept alongside it, so the thread
// shows the same reviewed plan the prose describes, never the planner's
// unreviewed draft.
func TestAsk_AReviewedPlanIsAlsoReturnedAsAnApprovableCard(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent: "meal-planner", DisplayName: "Kora Meal Planner", State: "completed",
			Text: `{"summary":"UNREVIEWED target claim","days":[{"date":"Monday","meals":[{"name":"Steak","description":"unsupported numbers"}]}]}`,
		},
		planReviewSkill: {
			Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor", State: "completed",
			Text: `This was amended against your 2000 kcal target. [cite:today_kcal_target] Approve it, or tell me what to change.
[[KORA_REVIEWED_PLAN]]
{"summary":"Reviewed meal plan","days":[{"date":"Monday","meals":[{"name":"Lentil bowl","description":"A reviewed option","preparation":"Simmer lentils, then fold through roasted vegetables."}]}]}
[[/KORA_REVIEWED_PLAN]]`,
		},
	}}
	thread := NewThreadRepository(db)
	svc := NewService(g, &fakeProvider{text: "plan"}, meter, &thread).WithAgents(runner)

	answer, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC), time.UTC, "plan my meals for the week")

	require.NoError(t, err)
	require.Equal(t, "This was amended against your 2000 kcal target. Approve it, or tell me what to change.", answer.Text)
	require.NotNil(t, answer.Plan)
	require.NotZero(t, answer.Plan.ID, "the card is approvable, so it has an id")
	require.Equal(t, "Reviewed meal plan", answer.Plan.Summary)
	require.Len(t, answer.Plan.Days, 1)
	require.Equal(t, "Lentil bowl", answer.Plan.Days[0].Meals[0].Name)
	require.NotContains(t, answer.Plan.Summary, "UNREVIEWED")
	require.Equal(t, "Simmer lentils, then fold through roasted vegetables.", answer.Plan.Days[0].Meals[0].Preparation)
	require.Equal(t, "Kora Meal Planner", answer.Plan.AgentName)
	require.Equal(t, "Kora Plan Supervisor", answer.Plan.ReviewedBy)
	require.Nil(t, answer.Plan.AcceptedAt, "a plan is a proposal until the user approves it")

	turns, err := thread.ListRecent(t.Context(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)
	require.NotNil(t, turns[1].Plan)
	require.Equal(t, answer.Plan.ID, turns[1].Plan.ID)
}

func TestAsk_AReviewWithoutCompletePreparationCannotBeApproved(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)
	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent: "meal-planner", DisplayName: "Kora Meal Planner", State: "completed",
			Text: `{"summary":"Draft","days":[{"date":"Day 1","meals":[{"name":"Oats","description":"Breakfast"}]}]}`,
		},
		planReviewSkill: {
			Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor", State: "completed",
			Text: `This is ready to approve.
[[KORA_REVIEWED_PLAN]]
{"summary":"Incomplete review","days":[{"date":"Day 1","meals":[{"name":"Oats","description":"Breakfast"}]}]}
[[/KORA_REVIEWED_PLAN]]`,
		},
	}}
	thread := NewThreadRepository(db)
	svc := NewService(g, &fakeProvider{text: "plan"}, meter, &thread).WithAgents(runner)

	answer, err := svc.Ask(
		t.Context(), userID, time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals",
	)

	require.NoError(t, err)
	require.Equal(t, planReviewUnavailableText, answer.Text)
	require.Nil(t, answer.Plan)
}

func TestAsk_AReviewWithoutAPlanOrCommitmentFailsClosed(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)
	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent: "meal-planner", DisplayName: "Kora Meal Planner", State: "completed",
			Text: `{"summary":"planner ignored its days contract"}`,
		},
		planReviewSkill: {
			Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor", State: "completed",
			Text: "This looks ready, but I omitted the machine decision.",
		},
	}}
	thread := NewThreadRepository(db)
	svc := NewService(g, &fakeProvider{text: "plan"}, meter, &thread).WithAgents(runner)

	answer, err := svc.Ask(
		t.Context(), userID, time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals",
	)

	require.NoError(t, err)
	require.Equal(t, planReviewUnavailableText, answer.Text)
	require.Nil(t, answer.Plan)
	require.Nil(t, answer.Proposal)
}

// A plan answered without a thread to store it in has no id, so there is
// nothing the user could approve — returning a card with no id would give
// them a button that 404s.
func TestAsk_AnUnstoredPlanCarriesNoCard(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{bySkill: map[string]agents.Run{
		planningSkill: {
			Agent: "meal-planner", DisplayName: "Kora Meal Planner", State: "completed",
			Text: `{"summary":"a week","days":[{"date":"Monday","meals":[{"name":"Oats"}]}]}`,
		},
		planReviewSkill: {
			Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor", State: "completed",
			Text: `Looks good against your targets.
[[KORA_REVIEWED_PLAN]]
{"summary":"Reviewed week","days":[{"date":"Monday","meals":[{"name":"Oats","description":"Warm breakfast","preparation":"Simmer oats with water until creamy."}]}]}
[[/KORA_REVIEWED_PLAN]]`,
		},
	}}
	svc := NewService(g, &fakeProvider{text: "plan"}, meter, nil).WithAgents(runner)

	answer, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC), time.UTC, "plan my meals for the week")

	require.NoError(t, err)
	require.Nil(t, answer.Plan)
	_ = db
}
