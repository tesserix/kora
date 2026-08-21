package coach

import (
	"context"
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

// fixedSelector stands in for a registry that has resolved a skill to an
// agent no phrase in the keyword table names.
type fixedSelector struct {
	name     agents.Name
	question string
}

func (s *fixedSelector) SelectForQuestion(_ context.Context, question string) agents.Name {
	s.question = question
	return s.name
}

func selectorFixture(t *testing.T) (*Grounder, *stubMeter) {
	t.Helper()
	db := testDB(t)
	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	g := NewGrounder(dashSvc, logRepo, memory.NewService(logRepo), fakeWeightSource{})
	return &g, &stubMeter{withinBudget: true}
}

func TestAskRoutesThroughTheRegistrySelector(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	grounder, meter := selectorFixture(t)

	delegator := &recordingDelegator{result: agents.Result{
		Text:  "Here is a four-week plan.",
		Usage: ai.Usage{Provider: "agentgateway", Model: "diet-planner", CallType: "agent_delegate"},
	}}
	selector := &fixedSelector{name: "diet-planner"}
	service := NewService(grounder, &fakeProvider{}, meter, nil).
		WithDelegator(delegator).
		WithSelector(selector)

	question := "help me lose 10 kilos over the next month"
	_, err := service.Ask(t.Context(), userID, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC), time.UTC, question)

	require.NoError(t, err)
	require.Equal(t, agents.Name("diet-planner"), delegator.name, "the selector's choice must be the agent delegated to")
	require.Equal(t, question, selector.question, "the selector must see the raw question, not the grounded prompt")
}

func TestAskKeepsKeywordRoutingWhenNoSelectorIsWired(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	grounder, meter := selectorFixture(t)

	delegator := &recordingDelegator{result: agents.Result{
		Text:  "Add beans to lunch.",
		Usage: ai.Usage{Provider: "agentgateway", Model: "nutrition-coach", CallType: "agent_delegate"},
	}}
	service := NewService(grounder, &fakeProvider{}, meter, nil).
		WithDelegator(delegator).
		WithSelector(nil)

	_, err := service.Ask(t.Context(), userID, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC), time.UTC, "how is my protein?")

	require.NoError(t, err)
	require.Equal(t, agents.NutritionCoach, delegator.name)
}

// main() passes a *agents.Registry that is nil when unconfigured. Stored in an
// interface it would be non-nil, so routing would call through a nil pointer.
func TestAskSurvivesATypedNilRegistrySelector(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	grounder, meter := selectorFixture(t)

	delegator := &recordingDelegator{result: agents.Result{
		Text:  "Add beans to lunch.",
		Usage: ai.Usage{Provider: "agentgateway", Model: "nutrition-coach", CallType: "agent_delegate"},
	}}
	var registry *agents.Registry
	service := NewService(grounder, &fakeProvider{}, meter, nil).
		WithDelegator(delegator).
		WithSelector(registry.AsSelector())

	_, err := service.Ask(t.Context(), userID, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC), time.UTC, "how is my protein?")

	require.NoError(t, err)
	require.Equal(t, agents.NutritionCoach, delegator.name)
}
