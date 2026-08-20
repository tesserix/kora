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

type recordingDelegator struct {
	name   agents.Name
	prompt string
	result agents.Result
	err    error
}

func (d *recordingDelegator) Delegate(_ context.Context, name agents.Name, prompt string) (agents.Result, error) {
	d.name = name
	d.prompt = prompt
	return d.result, d.err
}

func TestAskDelegatesToReviewedAgentWithGroundedContext(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	grounder := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})
	provider := &fakeProvider{text: "provider must not be called"}
	delegator := &recordingDelegator{result: agents.Result{
		Text:  "Add beans or yoghurt to lunch.",
		Usage: ai.Usage{Provider: "agentgateway", Model: "nutrition-coach", CallType: "agent_delegate"},
	}}
	meter := &stubMeter{withinBudget: true}
	service := NewService(&grounder, provider, meter, nil).WithDelegator(delegator)

	answer, err := service.Ask(t.Context(), userID, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC), time.UTC, "How can I improve lunch?")

	require.NoError(t, err)
	require.Equal(t, agents.NutritionCoach, delegator.name)
	require.Contains(t, delegator.prompt, "CONTEXT:")
	require.Contains(t, delegator.prompt, "QUESTION: How can I improve lunch?")
	require.Contains(t, delegator.prompt, "Never invent or guess a number")
	require.Equal(t, "Add beans or yoghurt to lunch.", answer.Text)
	require.NotEmpty(t, answer.Citations)
	require.Zero(t, provider.calls, "Otto must not bypass the agent through a direct model call")
	require.Len(t, meter.records, 1)
}

func TestAskSelectsMealPlannerThroughDelegator(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	grounder := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})
	delegator := &recordingDelegator{result: agents.Result{Text: "A three-day plan."}}
	service := NewService(&grounder, &fakeProvider{}, &stubMeter{withinBudget: true}, nil).WithDelegator(delegator)

	_, err := service.Ask(t.Context(), userID, time.Now(), time.UTC, "Please create a three day meal plan")

	require.NoError(t, err)
	require.Equal(t, agents.MealPlanner, delegator.name)
}

func TestAskRecordsDelegationTimeoutWithoutProviderFallback(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	grounder := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})
	provider := &fakeProvider{text: "must not be called"}
	delegator := &recordingDelegator{
		result: agents.Result{Usage: ai.Usage{Provider: "agentgateway", Model: "nutrition-coach", CallType: "agent_delegate"}},
		err:    context.DeadlineExceeded,
	}
	meter := &stubMeter{withinBudget: true}
	service := NewService(&grounder, provider, meter, nil).WithDelegator(delegator)

	_, err := service.Ask(t.Context(), userID, time.Now(), time.UTC, "How can I improve lunch?")

	require.Error(t, err)
	require.True(t, errors.Is(err, context.DeadlineExceeded))
	require.Zero(t, provider.calls)
	require.Len(t, meter.records, 1)
	require.Equal(t, ai.OutcomeTimeout, meter.records[0].Outcome)
}
