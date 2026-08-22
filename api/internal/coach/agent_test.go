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

func TestAsk_FallsBackToTheProviderWhenTheAgentFails(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	provider := &fakeProvider{
		text:      "from the provider",
		textUsage: ai.Usage{Provider: "stub", CallType: "coach"},
	}
	runner := &fakeRunner{err: errors.New("gateway unreachable")}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how am I doing?")

	require.NoError(t, err, "a failed agent must not cost the user an answer the provider can still give")
	require.Equal(t, "from the provider", a.Text)
	// Two: one to route, one to answer once the agent failed.
	require.Equal(t, 2, provider.calls)
	require.Len(t, meter.records, 2, "both the failed run and the fallback call must be metered")
	require.Equal(t, ai.OutcomeError, meter.records[0].Outcome)
	require.Equal(t, ai.OutcomeOK, meter.records[1].Outcome)
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

// A gateway 502 costs the user the agent, not the answer — but an unlabelled
// fallback is the misleading part: the published coach and the plain provider
// produced identical-looking replies. The answer names whoever wrote it, and
// that is never the agent whose run just failed.
func TestAsk_AProviderFallbackIsAttributedToOttoNotTheFailedAgent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	runner := &fakeRunner{err: errors.New("agents: a2a returned 502")}
	svc := NewService(g, &fakeProvider{text: "from the provider"}, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, "from the provider", a.Text)
	require.Equal(t, fallbackAgentName, a.By.Agent, "the thread never shows an anonymous reply")
	require.Equal(t, guidanceSkill, a.By.Skill)
	require.Empty(t, a.By.ReviewedBy)
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
// draft must never reach the user raw. The coach reviews it against the
// user's numbers and presents it, and the user is told both names.
func TestAsk_APlanDraftIsReviewedByTheCoach(t *testing.T) {
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
		guidanceSkill: {
			Agent:       "nutrition-coach",
			DisplayName: "Kora Nutrition Coach",
			State:       "completed",
			Text:        "This draft fits your 2000 kcal target. Day 1: ... Approve, or tell me what to change.",
		},
	}}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals for the week")

	require.NoError(t, err)
	require.Equal(t, []string{planningSkill, guidanceSkill}, runner.skills, "the draft goes to the coach for review")
	require.Contains(t, runner.prompts[1], `{"summary":"fits your targets"`, "the reviewer sees the draft")
	require.Contains(t, a.Text, "Approve, or tell me what to change", "the user reads the review, not the draft")
	require.Equal(t, "Kora Meal Planner", a.By.Agent)
	require.Equal(t, "Kora Nutrition Coach", a.By.ReviewedBy)
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
		guidanceSkill: {
			Agent: "nutrition-coach", DisplayName: "Kora Nutrition Coach",
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

// A review that cannot happen must not cost the user the plan: the draft is
// still the answer, with no reviewer attributed.
func TestAsk_AFailedReviewKeepsThePlannerDraft(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)

	// The provider answers the classifier with "plan", then fails every later
	// call — so the review's provider fallback fails too and the draft stands.
	provider := &flakyProvider{fakeProvider: fakeProvider{text: "plan"}, failAfter: 1}
	runner := &fakeRunner{
		bySkill: map[string]agents.Run{
			planningSkill: {
				Agent:       "meal-planner",
				DisplayName: "Kora Meal Planner",
				State:       "completed",
				Text:        "Day 1: oats. Day 2: eggs.",
			},
		},
		errBy: map[string]error{guidanceSkill: errors.New("gateway unreachable")},
	}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my meals for the week")

	require.NoError(t, err)
	require.Equal(t, "Day 1: oats. Day 2: eggs.", a.Text, "the draft survives a failed review")
	require.Equal(t, "Kora Meal Planner", a.By.Agent)
	require.Empty(t, a.By.ReviewedBy)
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

// flakyProvider succeeds for its first failAfter GenerateText calls and then
// errors — the shape of "the classifier worked, the fallback did not".
type flakyProvider struct {
	fakeProvider
	failAfter int
}

func (f *flakyProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	if f.calls >= f.failAfter {
		f.calls++
		return "", ai.Usage{}, errors.New("provider down")
	}
	return f.fakeProvider.GenerateText(ctx, systemPrompt, userPrompt)
}

// A review can fail — a gateway timeout, a provider outage — and when it does
// the draft is still the only answer there is. It must reach the user as
// prose, never as the planner's raw JSON envelope (kora capture thread).
func TestAsk_AnUnreviewedPlanDraftIsStillReadable(t *testing.T) {
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
		errBy: map[string]error{guidanceSkill: errors.New("gateway timeout")},
	}
	svc := NewService(g, provider, meter, nil).WithAgents(runner)

	a, err := svc.Ask(context.Background(), userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC,
		"plan my dinner for tonight")

	require.NoError(t, err)
	require.NotContains(t, a.Text, `"summary"`, "the user never reads raw JSON")
	require.NotContains(t, a.Text, "{")
	require.Contains(t, a.Text, "High-protein dinners.")
	require.Contains(t, a.Text, "Day 1")
	require.Contains(t, a.Text, "- Dinner: Steak — 180g sirloin.")
	require.Empty(t, a.By.ReviewedBy, "an unreviewed draft claims no reviewer")
	_ = db
}
