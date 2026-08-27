package platformadmin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/platformauth"
)

// ErrItemNotFound means no inbox item carries this id, in either queue.
var ErrItemNotFound = errors.New("platformadmin: inbox item not found")

// ErrActionNotDeclared means the item exists but does not offer this action in
// its current status.
//
// This is §8.3's load-bearing rule and the reason the read side's `actions`
// array is a contract rather than documentation: a product that accepted any
// action name it happens to implement would leave the console unable to render
// a queue safely, because the buttons it drew would not predict what the
// product would accept.
var ErrActionNotDeclared = errors.New("platformadmin: action not declared by this item")

// InboxActor performs a triage transition on one queue item.
//
// Deliberately narrow: these move a queue row's OWN status and nothing else.
// The console can now write (contract §447, reversed 2026-08-27), but "can
// write" is not "can write anything" — resolve-to-food and add-alias are
// excluded because a curated alias resolves at score 1.0, the auto-log tier.
type InboxActor interface {
	// Apply moves the item to the status this action implies. It returns
	// ErrItemNotFound when no such item exists and ErrActionNotDeclared when
	// the item does not offer the action right now.
	Apply(ctx context.Context, itemID uuid.UUID, actionID string, actor InboxActorIdentity) error
}

// InboxActorIdentity is who asked, as the GATEWAY asserted them.
//
// §8.4: the capability is asserted at the gateway and recorded, not decided by
// the product. Kora therefore records what it was told rather than validating
// it against a vocabulary — which is also what mark8ly does today, where every
// RequiredWriteCapabilities value is empty for the same reason. When that
// vocabulary settles, both products fill it in together rather than inventing
// two dialects.
type InboxActorIdentity struct {
	Operator   string
	Capability string
}

// InboxActionHandler serves POST /admin/inbox/:id/actions/:actionId (§8.3).
type InboxActionHandler struct {
	actor  InboxActor
	logger *slog.Logger
}

// NewInboxActionHandler builds the handler. logger may be nil.
func NewInboxActionHandler(actor InboxActor, logger *slog.Logger) *InboxActionHandler {
	return &InboxActionHandler{actor: actor, logger: logger}
}

// idempotencyHeader is what a caller sends so a retried destructive action
// does not fire twice.
const idempotencyHeader = "Idempotency-Key"

// Apply executes one declared action.
func (h *InboxActionHandler) Apply(c *gin.Context) {
	itemID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		// A malformed id is a bad request, NOT a 404: "that is not an id" and
		// "no item has that id" are different answers, and collapsing them
		// sends an operator hunting a missing row that never existed.
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "item id must be a uuid")
		return
	}

	actionID := strings.TrimSpace(c.Param("actionId"))
	if actionID == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "action id is required")
		return
	}

	// §8.3: a destructive action must carry an idempotency key, so a retry
	// after a timeout cannot fire twice. Checked BEFORE the item is loaded —
	// a caller that forgot the header should learn that whether or not the id
	// happens to exist, and the answer must not leak which ids do.
	if isDestructiveAction(actionID) && strings.TrimSpace(c.GetHeader(idempotencyHeader)) == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input",
			"a destructive action requires an "+idempotencyHeader+" header")
		return
	}

	identity := InboxActorIdentity{
		Operator:   c.GetHeader(platformauth.HeaderOperator),
		Capability: c.GetHeader(platformauth.HeaderCapability),
	}

	err = h.actor.Apply(c.Request.Context(), itemID, actionID, identity)
	switch {
	case errors.Is(err, ErrItemNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "no inbox item with that id")
	case errors.Is(err, ErrActionNotDeclared):
		// 409, not 400: the request is well formed and the action is one Kora
		// implements — it is this ITEM, in this status, that does not offer
		// it. Most often that means someone else already worked it, which is
		// a conflict rather than a malformed request.
		httpx.Error(c, http.StatusConflict, "conflict",
			"this item does not offer that action in its current state")
	case err != nil:
		if h.logger != nil {
			h.logger.Error("platformadmin: apply inbox action",
				"item_id", itemID.String(), "action", actionID, "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not apply the action")
	default:
		httpx.OK(c, gin.H{"applied": true, "action": actionID})
	}
}

// isDestructiveAction mirrors the `destructive` flag the read side declares.
//
// Derived from one place so the two cannot drift: an action advertised as
// destructive but not requiring a key, or the reverse, would make the
// contract's own flag misleading.
func isDestructiveAction(actionID string) bool {
	for _, a := range actionsFor(string(statusWithEveryAction)) {
		if a.ID == actionID {
			return a.Destructive
		}
	}
	return false
}

// statusWithEveryAction is the status whose action list is the superset — used
// only to look an action's flags up by id. Stated as a constant so the lookup
// above cannot silently start reading a narrower list.
const statusWithEveryAction = "open"

// statusForAction maps a declared action onto the status it moves an item to.
func statusForAction(actionID string) (string, bool) {
	switch actionID {
	case ActionStart:
		return "in_progress", true
	case ActionResolve:
		return "resolved", true
	case ActionDismiss:
		// Dismiss closes WITHOUT a fix, which is why it is the destructive
		// one: the work leaves the queue on a judgement rather than on having
		// been done.
		return "closed", true
	default:
		return "", false
	}
}

// Apply moves one inbox item to the status its action implies.
//
// The item may live in EITHER queue — food_resolution_outcomes or feedback —
// and the console does not know which, because §3.2's inbox merges them behind
// one id space. So this tries each in turn and reports ErrItemNotFound only
// when neither holds it.
//
// The update is guarded on the item's CURRENT status, not just its id. That is
// what makes "the item did not declare this action" a real check rather than a
// re-read: two operators working the same queue race, and the loser must be
// told the item moved rather than silently overwriting the winner.
func (r Repository) Apply(ctx context.Context, itemID uuid.UUID, actionID string, actor InboxActorIdentity) error {
	next, ok := statusForAction(actionID)
	if !ok {
		// Not an action Kora implements at all. Reported as not-declared
		// rather than as a 500: from the caller's side "Kora has no such
		// action" and "this item does not offer it" are the same refusal.
		return ErrActionNotDeclared
	}

	for _, table := range []string{"food_resolution_outcomes", "feedback"} {
		var current string
		err := r.db.WithContext(ctx).
			Raw("SELECT status FROM "+table+" WHERE id = ?", itemID).
			Scan(&current).Error
		if err != nil {
			return fmt.Errorf("platformadmin: read %s status: %w", table, err)
		}
		if current == "" {
			continue // not in this queue
		}

		// The declared list is the authority, evaluated against the status the
		// row has RIGHT NOW.
		if !declares(actionsFor(current), actionID) {
			return ErrActionNotDeclared
		}

		res := r.db.WithContext(ctx).
			Exec("UPDATE "+table+" SET status = ? WHERE id = ? AND status = ?", next, itemID, current)
		if res.Error != nil {
			return fmt.Errorf("platformadmin: apply %s on %s: %w", actionID, table, res.Error)
		}
		if res.RowsAffected == 0 {
			// Someone moved it between the read and the write. Reported as a
			// conflict, which is what it is.
			return ErrActionNotDeclared
		}
		return nil
	}
	return ErrItemNotFound
}

// declares reports whether this action appears in the item's own list.
func declares(actions []inboxAction, actionID string) bool {
	for _, a := range actions {
		if a.ID == actionID {
			return true
		}
	}
	return false
}
