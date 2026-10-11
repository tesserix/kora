package platformadmin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/feedback"
)

// stubActor records what reached the write layer.
type stubActor struct {
	err       error
	gotItem   uuid.UUID
	gotAction string
	gotActor  InboxActorIdentity
	calls     int
}

func (s *stubActor) Apply(_ context.Context, itemID uuid.UUID, actionID string, actor InboxActorIdentity) error {
	s.calls++
	s.gotItem, s.gotAction, s.gotActor = itemID, actionID, actor
	return s.err
}

func actionRequest(t *testing.T, method, target string, actor *stubActor, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/admin/inbox/:id/actions/:actionId", NewInboxActionHandler(actor, nil).Apply)

	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestDestructiveActionRequiresAnIdempotencyKey is §8.3's second hard rule.
//
// A queue action retried after a timeout must not fire twice, and `dismiss`
// removes work from the queue on a judgement rather than a fix — so a
// duplicate silently loses an item nobody looked at again.
//
// The check runs BEFORE the item is loaded, on purpose: a caller that forgot
// the header learns that whether or not the id exists, and the refusal does not
// leak which ids do.
func TestDestructiveActionRequiresAnIdempotencyKey(t *testing.T) {
	actor := &stubActor{}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/dismiss", actor, nil)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, 0, actor.calls, "a destructive action must not reach the write layer without a key")
}

// TestNonDestructiveActionNeedsNoKey — requiring one everywhere would make the
// `destructive` flag the read side declares meaningless.
func TestNonDestructiveActionNeedsNoKey(t *testing.T) {
	actor := &stubActor{}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/start", actor, nil)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, actor.calls)
}

// TestDestructiveActionProceedsWithAKey
func TestDestructiveActionProceedsWithAKey(t *testing.T) {
	actor := &stubActor{}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/dismiss", actor,
		map[string]string{idempotencyHeader: "retry-once"})

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, actor.calls)
}

// TestTheDestructiveFlagAndTheKeyRequirementCannotDrift
//
// isDestructiveAction is derived from the SAME list the read side publishes.
// An action advertised as destructive but not requiring a key — or the reverse
// — would make the contract's own flag misleading, and the console renders its
// confirmation prompt from that flag.
func TestTheDestructiveFlagAndTheKeyRequirementCannotDrift(t *testing.T) {
	for _, a := range actionsFor("open") {
		require.Equal(t, a.Destructive, isDestructiveAction(a.ID),
			"action %q advertises destructive=%v but the key requirement disagrees", a.ID, a.Destructive)
	}
}

// TestAnUndeclaredActionIsRefusedAsAConflict pins §8.3's load-bearing rule.
//
// 409 rather than 400: the request is well formed and Kora implements the
// action — it is this ITEM, in this status, that does not offer it. Most often
// that means another operator already worked it.
func TestAnUndeclaredActionIsRefusedAsAConflict(t *testing.T) {
	actor := &stubActor{err: ErrActionNotDeclared}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/start", actor, nil)

	assert.Equal(t, http.StatusConflict, rec.Code)
}

// TestAMissingItemIsNotFound — distinct from the conflict above, because "no
// such item" and "that item will not do this" send an operator to different
// places.
func TestAMissingItemIsNotFound(t *testing.T) {
	actor := &stubActor{err: ErrItemNotFound}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/start", actor, nil)

	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// TestAMalformedIdIsABadRequestNotANotFound — "that is not an id" and "no item
// has that id" are different answers; collapsing them sends an operator
// hunting a row that never existed.
func TestAMalformedIdIsABadRequestNotANotFound(t *testing.T) {
	actor := &stubActor{}
	rec := actionRequest(t, http.MethodPost, "/admin/inbox/not-a-uuid/actions/start", actor, nil)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, 0, actor.calls)
}

// TestTheGatewaysOperatorAndCapabilityReachTheWriteLayer
//
// §8.4: the capability is asserted at the gateway and RECORDED, not decided by
// the product. Kora must therefore carry it through rather than drop it.
func TestTheGatewaysOperatorAndCapabilityReachTheWriteLayer(t *testing.T) {
	actor := &stubActor{}
	actionRequest(t, http.MethodPost, "/admin/inbox/"+uuid.NewString()+"/actions/start", actor,
		map[string]string{"X-Platform-Operator": "ops-42", "X-Platform-Capability": "platform"})

	assert.Equal(t, "ops-42", actor.gotActor.Operator)
	assert.Equal(t, "platform", actor.gotActor.Capability)
}

// TestAnItemOffersOnlyWhatItsStatusAllows — the console renders exactly this
// list, so an action that is not valid right now must not appear. An offered
// button that then 409s is the failure §8.3 exists to prevent.
func TestAnItemOffersOnlyWhatItsStatusAllows(t *testing.T) {
	ids := func(as []inboxAction) []string {
		out := make([]string, 0, len(as))
		for _, a := range as {
			out = append(out, a.ID)
		}
		return out
	}

	assert.Equal(t, []string{ActionStart, ActionResolve, ActionDismiss}, ids(actionsFor("open")))
	assert.Equal(t, []string{ActionResolve, ActionDismiss}, ids(actionsFor("in_progress")),
		"an item already in progress must not offer to be started again")
	assert.Empty(t, ids(actionsFor("resolved")), "a terminal item offers nothing")
	assert.Empty(t, ids(actionsFor("closed")))
}

// --- against a real database -------------------------------------------
//
// The handler tests above use a stub, which proves the HTTP contract and
// nothing about whether an item actually moves. These drive Repository.Apply.

// TestApplyMovesAFeedbackItemThroughItsLifecycle
func TestApplyMovesAFeedbackItemThroughItsLifecycle(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	ctx := context.Background()
	id := seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "Zephyr crash", time.Now())

	status := func() string {
		var s string
		require.NoError(t, tx.Raw("SELECT status FROM feedback WHERE id = ?", id).Scan(&s).Error)
		return s
	}

	require.NoError(t, repo.Apply(ctx, id, ActionStart, InboxActorIdentity{Operator: "ops"}))
	assert.Equal(t, "in_progress", status())

	require.NoError(t, repo.Apply(ctx, id, ActionResolve, InboxActorIdentity{Operator: "ops"}))
	assert.Equal(t, "resolved", status())
}

// TestApplyRefusesAnActionTheItemNoLongerOffers is the race two operators
// working one queue will actually hit: the second must be told the item moved
// rather than silently overwriting the first.
func TestApplyRefusesAnActionTheItemNoLongerOffers(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	ctx := context.Background()
	id := seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "Zephyr crash", time.Now())

	require.NoError(t, repo.Apply(ctx, id, ActionStart, InboxActorIdentity{}))
	// `start` is not offered by an in_progress item.
	err := repo.Apply(ctx, id, ActionStart, InboxActorIdentity{})
	require.ErrorIs(t, err, ErrActionNotDeclared)

	var s string
	require.NoError(t, tx.Raw("SELECT status FROM feedback WHERE id = ?", id).Scan(&s).Error)
	assert.Equal(t, "in_progress", s, "the refused action must not have moved anything")
}

// TestApplyReportsAnUnknownItem — the id space is merged across two tables, so
// "not found" means neither queue holds it.
func TestApplyReportsAnUnknownItem(t *testing.T) {
	tx := tx(t, testDB(t))
	err := repoOn(tx).Apply(context.Background(), uuid.New(), ActionStart, InboxActorIdentity{})
	require.ErrorIs(t, err, ErrItemNotFound)
}

// TestApplyRefusesAnActionKoraDoesNotImplement — resolve-to-food and add-alias
// are deliberately NOT offered (a curated alias resolves at the auto-log tier),
// so asking for one must be refused rather than half-handled.
func TestApplyRefusesAnActionKoraDoesNotImplement(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	id := seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "Zephyr crash", time.Now())

	err := repo.Apply(context.Background(), id, "add-alias", InboxActorIdentity{})
	require.ErrorIs(t, err, ErrActionNotDeclared)
}
