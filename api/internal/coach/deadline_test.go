package coach

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/agents"
)

// slowRunner holds each skill for its delay, or until the caller gives up.
type slowRunner struct {
	mu        sync.Mutex
	delay     map[string]time.Duration
	reply     map[string]agents.Run
	remaining map[string]time.Duration
}

func (r *slowRunner) Run(ctx context.Context, skill, _ string) (agents.Run, error) {
	if deadline, ok := ctx.Deadline(); ok {
		r.mu.Lock()
		r.remaining[skill] = time.Until(deadline)
		r.mu.Unlock()
	}
	select {
	case <-time.After(r.delay[skill]):
		return r.reply[skill], nil
	case <-ctx.Done():
		return agents.Run{}, ctx.Err()
	}
}

const reviewedPlanReply = `Fits your targets. Approve, or tell me what to change.
[[KORA_REVIEWED_PLAN]]
{"summary":"Reviewed plan","days":[{"date":"Day 1","meals":[{"name":"Oats","description":"Breakfast","preparation":"Simmer oats."}]}]}
[[/KORA_REVIEWED_PLAN]]`

func deadlineService(t *testing.T, runner *slowRunner) (*Service, func(context.Context) (Answer, error)) {
	t.Helper()
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	g, meter := askFixture(t)
	svc := NewService(g, &fakeProvider{text: "plan"}, meter, nil).WithAgents(runner)
	svc.agentDeadline, svc.reviewReserve = 600*time.Millisecond, 250*time.Millisecond
	return svc, func(ctx context.Context) (Answer, error) {
		return svc.Ask(ctx, userID, time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "plan my meals for the week")
	}
}

func newSlowRunner(planner, reviewer time.Duration) *slowRunner {
	return &slowRunner{
		delay: map[string]time.Duration{planningSkill: planner, planReviewSkill: reviewer},
		reply: map[string]agents.Run{
			planningSkill:   {Agent: "meal-planner", DisplayName: "Kora Meal Planner", State: "completed", Text: `{"summary":"draft","days":[]}`},
			planReviewSkill: {Agent: "plan-supervisor", DisplayName: "Kora Plan Supervisor", State: "completed", Text: reviewedPlanReply},
		},
		remaining: map[string]time.Duration{},
	}
}

func TestAskDegradesWhenThePlannerOutlivesItsShare(t *testing.T) {
	runner := newSlowRunner(time.Hour, 0)
	_, ask := deadlineService(t, runner)

	started := time.Now()
	a, err := ask(context.Background())

	require.NoError(t, err)
	require.Less(t, time.Since(started), 600*time.Millisecond, "the planner must not consume the reviewer's reserve")
	require.Equal(t, planTimeoutText, a.Text)
	require.Nil(t, a.Plan, "no unreviewed plan is offered")
	_, reviewed := runner.remaining[planReviewSkill]
	require.False(t, reviewed, "a timed-out draft is never sent for review")
}

func TestAskReturnsBeforeTheDeadlineWhenTheReviewerHangs(t *testing.T) {
	runner := newSlowRunner(0, time.Hour)
	_, ask := deadlineService(t, runner)

	started := time.Now()
	a, err := ask(context.Background())

	require.NoError(t, err)
	require.Less(t, time.Since(started), 700*time.Millisecond)
	require.Equal(t, planReviewUnavailableText, a.Text)
	require.Nil(t, a.Plan)
}

func TestAskGuaranteesTheReviewerItsReserve(t *testing.T) {
	runner := newSlowRunner(300*time.Millisecond, 0)
	_, ask := deadlineService(t, runner)

	a, err := ask(context.Background())

	require.NoError(t, err)
	require.Equal(t, "Kora Plan Supervisor", a.By.ReviewedBy, "a planner that finishes inside its share still gets reviewed")
	require.Contains(t, a.Text, "Fits your targets")
	require.GreaterOrEqual(t, runner.remaining[planReviewSkill], 200*time.Millisecond)
	require.LessOrEqual(t, runner.remaining[planningSkill], 350*time.Millisecond, "the planner's share excludes the reserve")
}

func TestTheAgentDeadlineStaysBelowTheMobileDeadline(t *testing.T) {
	const mobileAgentTimeout = 90 * time.Second // apps/mobile/src/lib/api.ts AGENT_REQUEST_TIMEOUT_MS
	require.Less(t, defaultAgentDeadline, mobileAgentTimeout-5*time.Second)
	require.Less(t, defaultReviewReserve, defaultAgentDeadline/2)
}
