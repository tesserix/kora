package platformadmin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/feedback"
	"github.com/tesserix/kora/api/internal/httpx"
)

// Inbox item kinds. `kind` is product-defined by the contract, so these are
// Kora's vocabulary and nothing else's.
const (
	// KindFeedback is a bug report or feature request awaiting triage.
	KindFeedback = "feedback"
)

// Severity values. The contract's example uses "normal"; a bug report is
// raised above a feature request because a defect that mis-logs someone's
// intake is not the same kind of waiting as a suggestion.
const (
	SeverityNormal = "normal"
	SeverityHigh   = "high"
)

// openFeedbackStatuses are the statuses that mean "still waiting on a human".
//
// Derived from feedback.Status's own lifecycle rather than restated as
// literals, so a status added there cannot silently fall out of the inbox —
// or silently into it. resolved and closed are the two terminal states; every
// other status is work.
var openFeedbackStatuses = []feedback.Status{feedback.StatusOpen, feedback.StatusInProgress}

// InboxResult is everything waiting on a human, already bounded.
type InboxResult struct {
	Items []feedback.Feedback
	Total int64
}

// InboxSource reads Kora's human-waiting queues.
type InboxSource interface {
	ListInbox(ctx context.Context, limit, offset int) (InboxResult, error)
}

// ListInbox reads open feedback, oldest first.
//
// Oldest first is the ordering, not newest: an inbox exists to surface what
// has been waiting longest, and a newest-first queue hides exactly the item
// that most needs attention behind a page boundary.
func (r Repository) ListInbox(ctx context.Context, limit, offset int) (InboxResult, error) {
	db := r.db.WithContext(ctx).
		Model(&feedback.Feedback{}).
		Where("status IN ?", openFeedbackStatuses)

	var total int64
	if err := db.Count(&total).Error; err != nil {
		return InboxResult{}, fmt.Errorf("platformadmin: count inbox: %w", err)
	}

	var rows []feedback.Feedback
	if err := db.Order("created_at ASC").Limit(limit).Offset(offset).
		Find(&rows).Error; err != nil {
		return InboxResult{}, fmt.Errorf("platformadmin: list inbox: %w", err)
	}
	return InboxResult{Items: rows, Total: total}, nil
}

// inboxAction is one action the item declares. §8.2 requires a product to
// reject an action absent from the item's own list, so this array is a
// contract rather than documentation.
type inboxAction struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Destructive bool   `json:"destructive"`
}

// inboxItem is §3.2's shape.
//
// DueAt is a pointer so it marshals as null rather than as an empty string.
// Kora has no SLA on this queue, so null is the honest value — the contract
// asks for due_at "where an SLA exists", and a fabricated deadline is worse
// than an absent one because the console would sort and colour by it.
type inboxItem struct {
	ID           string        `json:"id"`
	Kind         string        `json:"kind"`
	Title        string        `json:"title"`
	Subtitle     string        `json:"subtitle"`
	WaitingSince string        `json:"waiting_since"`
	DueAt        *string       `json:"due_at"`
	Severity     string        `json:"severity"`
	Href         string        `json:"href,omitempty"`
	Actions      []inboxAction `json:"actions"`
}

// InboxHandler serves GET /admin/inbox.
type InboxHandler struct {
	src    InboxSource
	logger *slog.Logger
}

// NewInboxHandler builds the handler. logger may be nil.
func NewInboxHandler(src InboxSource, logger *slog.Logger) *InboxHandler {
	return &InboxHandler{src: src, logger: logger}
}

// List handles GET /admin/inbox.
//
// One queue is exposed today: feedback awaiting triage. #432 also named
// failed and low-confidence food resolutions, and they are genuinely the
// second queue worth watching — but NOTHING PERSISTS THEM. There is no table,
// no column and no write path recording a resolution outcome, so the only
// honest options were to omit the kind or to invent it. It is omitted, and
// tracked separately; see docs/admin-contract.md. Do not add an
// `unresolved_food` kind here that reads from something adjacent — a queue
// that is always empty because it is measuring the wrong thing is exactly the
// failure §4.5 and #420 both describe.
func (h *InboxHandler) List(c *gin.Context) {
	q := parseQuery(c, nowUTC())

	result, err := h.src.ListInbox(c.Request.Context(), q.Limit, q.Offset())
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: list inbox", "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error",
			"could not read the inbox")
		return
	}

	// Allocated, never nil: §4.5. An empty inbox means "nothing is waiting",
	// which is the answer an operator most wants to be able to trust.
	items := make([]inboxItem, 0, len(result.Items))
	for _, f := range result.Items {
		items = append(items, toInboxItem(f))
	}

	// §3.2's shape is {items, total}, NOT §4.1's {data, pagination}. The
	// contract names both and they are different; the inbox one is what the
	// console's front door reads.
	c.JSON(http.StatusOK, gin.H{"items": items, "total": result.Total})
}

func toInboxItem(f feedback.Feedback) inboxItem {
	severity := SeverityNormal
	if f.Kind == feedback.KindBug {
		severity = SeverityHigh
	}

	return inboxItem{
		ID:           f.ID.String(),
		Kind:         KindFeedback,
		Title:        f.Subject,
		Subtitle:     inboxSubtitle(f),
		WaitingSince: stamp(f.CreatedAt),
		DueAt:        nil,
		Severity:     severity,
		// Href is deliberately empty. It must point somewhere that exists in
		// the console, and console-core still marks every Kora route
		// `pending` — an href to a 404 is worse than no href.
		Href: "",
		// No actions are declared. §8.2's execution endpoint
		// (POST /admin/inbox/{id}/actions/{actionId}) is not implemented
		// here, and §3.2 says to declare only actions the product can
		// actually perform. A "Resolve" button that 404s is a worse inbox
		// than one with no buttons.
		Actions: []inboxAction{},
	}
}

// inboxSubtitle carries the client context that makes a report actionable —
// what kind of report it is and which build it came from.
//
// It never carries the description. That is free text a user typed, it can
// run to 4000 characters, and the console renders subtitles on one line.
func inboxSubtitle(f feedback.Feedback) string {
	subtitle := string(f.Kind)
	if f.Platform != "" && f.AppVersion != "" {
		subtitle = fmt.Sprintf("%s · %s %s", subtitle, f.Platform, f.AppVersion)
	}
	return subtitle
}
