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
}

func (f *fakeRunner) Run(_ context.Context, skill, prompt string) (agents.Run, error) {
	f.calls++
	f.skill, f.prompt = skill, prompt
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
	require.Equal(t, 0, provider.calls, "the provider must not be called when the agent answered")
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
	require.Equal(t, 1, provider.calls)
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
