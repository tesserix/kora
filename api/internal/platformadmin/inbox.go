package platformadmin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/feedback"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

// Inbox item kinds. `kind` is product-defined by the contract, so these are
// Kora's vocabulary and nothing else's.
const (
	// KindFeedback is a bug report or feature request awaiting triage.
	KindFeedback = "feedback"
	// KindUnresolvedFood is a resolve attempt that left work for a human:
	// the food index either had only near-misses or had nothing at all.
	KindUnresolvedFood = "unresolved_food"
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

// UnresolvedResult is the food-resolution half of the inbox.
type UnresolvedResult struct {
	Items []resolveoutcome.Outcome
	Total int64
}

// InboxSource reads Kora's human-waiting queues.
type InboxSource interface {
	ListInbox(ctx context.Context, limit, offset int) (InboxResult, error)
}

// UnresolvedSource reads the food-resolution triage queue. A SEPARATE
// interface from InboxSource so a deployment without the outcome recorder
// (or a test) can supply one and not the other — the handler treats a nil
// source as "this queue is not available", which is different from "empty".
type UnresolvedSource interface {
	ListTriage(ctx context.Context, p resolveoutcome.TriageParams) ([]resolveoutcome.Outcome, int64, error)
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

// Inbox action ids. These are the ONLY actions Kora accepts, and an item
// offers a subset of them — §8.3 requires refusing an action the item did not
// declare, so this list is the outer bound and the item's own array is the
// inner one.
//
// All three are TRIAGE transitions: they move a queue row's own status and
// touch nothing else. Deliberately absent are `resolve-to-food` and
// `add-alias`, which #484 also proposes: a curated alias resolves at score 1.0
// — the auto-log tier — so a wrong one silently logs the wrong food for every
// user. Today those live in a reviewed data file where each entry carries a
// stated `why` (see data/food/aliases.json), and moving that behind a console
// button removes the review rather than the work. That is a separate decision
// from "the console may write", which is the one taken here.
const (
	// ActionStart claims an item — the operator is working it.
	ActionStart = "start"
	// ActionResolve marks the work done.
	ActionResolve = "resolve"
	// ActionDismiss closes an item WITHOUT it having been fixed: noise, a
	// duplicate, or a phrase nobody will act on. Destructive, because it
	// removes work from the queue on the strength of a judgement rather than
	// a fix, and a queue that quietly loses items is worse than a long one.
	ActionDismiss = "dismiss"
)

// actionsFor returns what an item in this status may be asked to do.
//
// Driven by the CURRENT status rather than fixed per kind: an item already in
// progress must not offer "start" again, and a terminal item offers nothing.
// The console renders exactly this list, so an action that is not valid right
// now must not appear — an offered button that then 400s is the failure §8.3
// exists to prevent.
func actionsFor(status string) []inboxAction {
	switch status {
	case string(resolveoutcome.StatusOpen):
		return []inboxAction{
			{ID: ActionStart, Label: "Start", Destructive: false},
			{ID: ActionResolve, Label: "Mark resolved", Destructive: false},
			{ID: ActionDismiss, Label: "Dismiss", Destructive: true},
		}
	case string(resolveoutcome.StatusInProgress):
		return []inboxAction{
			{ID: ActionResolve, Label: "Mark resolved", Destructive: false},
			{ID: ActionDismiss, Label: "Dismiss", Destructive: true},
		}
	default:
		// Terminal. The read side only lists open work, so this is defensive
		// rather than reachable — but an empty list is the honest answer for
		// an item nobody can act on.
		return []inboxAction{}
	}
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
	src        InboxSource
	unresolved UnresolvedSource
	logger     *slog.Logger
}

// NewInboxHandler builds the handler. logger may be nil.
func NewInboxHandler(src InboxSource, logger *slog.Logger) *InboxHandler {
	return &InboxHandler{src: src, logger: logger}
}

// WithUnresolvedFoods attaches the food-resolution queue (kora#459). Optional,
// so the feedback half of the inbox keeps working on its own.
func (h *InboxHandler) WithUnresolvedFoods(src UnresolvedSource) *InboxHandler {
	h.unresolved = src
	return h
}

// List handles GET /admin/inbox.
//
// Two queues, merged into one shape and ordered oldest-first across both:
// feedback awaiting triage, and resolve attempts that left work for a human
// (kora#459 — an index with only near-misses, or an index gap).
//
// Both halves are paged from the same offset independently and then merged,
// which means a page boundary can interleave imperfectly when both queues are
// deep. That is accepted: the alternative is a UNION across two tables with
// different shapes, and the console renders a bounded front door rather than
// an exhaustive ledger. `total` is exact for both.
//
// When no UnresolvedSource is wired the food half is simply absent — NOT
// reported as empty. "This queue is not available" and "this queue is clear"
// are different facts, and only one of them means an operator can stop
// looking.
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
	total := result.Total

	if h.unresolved != nil {
		rows, unresolvedTotal, err := h.unresolved.ListTriage(c.Request.Context(),
			resolveoutcome.TriageParams{Limit: q.Limit, Offset: q.Offset()})
		if err != nil {
			// The whole endpoint fails rather than returning the feedback half
			// alone. A partial inbox is indistinguishable from a complete one,
			// and an operator who reads it as complete stops looking — which
			// is the precise failure a front door must not have.
			if h.logger != nil {
				h.logger.Error("platformadmin: list unresolved foods", "err", err)
			}
			httpx.Error(c, http.StatusInternalServerError, "internal_error",
				"could not read the inbox")
			return
		}
		for _, o := range rows {
			items = append(items, toUnresolvedItem(o))
		}
		total += unresolvedTotal
	}

	// Oldest first across both queues. Sorting after the merge rather than
	// relying on either query's own order, because the two are independent.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].WaitingSince < items[j].WaitingSince
	})

	// §3.2's shape is {items, total}, NOT §4.1's {data, pagination}. The
	// contract names both and they are different; the inbox one is what the
	// console's front door reads.
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total})
}

// toUnresolvedItem renders one failed resolution as an inbox item.
func toUnresolvedItem(o resolveoutcome.Outcome) inboxItem {
	// An index GAP is worse than a near-miss: the near-miss at least logged
	// something the user could correct, while a gap ended the attempt with
	// nothing. Severity says so rather than treating every failure alike.
	severity := SeverityNormal
	if o.Kind == resolveoutcome.KindNoMatch {
		severity = SeverityHigh
	}

	title := "(no phrase)"
	if o.Phrase != nil && strings.TrimSpace(*o.Phrase) != "" {
		title = *o.Phrase
	}

	return inboxItem{
		ID:           o.ID.String(),
		Kind:         KindUnresolvedFood,
		Title:        title,
		Subtitle:     unresolvedSubtitle(o),
		WaitingSince: stamp(o.CreatedAt),
		DueAt:        nil,
		Severity:     severity,
		Href:         "",
		Actions:      actionsFor(string(o.Status)),
	}
}

// unresolvedSubtitle says which KIND of failure this was and how close the
// index got, because those two facts are what decide the fix: a near-miss is
// fixed by lowering the floor, a gap only by adding data.
func unresolvedSubtitle(o resolveoutcome.Outcome) string {
	subtitle := fmt.Sprintf("%s · %s", o.Kind, o.Mode)
	if o.TopScore != nil {
		subtitle = fmt.Sprintf("%s · best %.2f of %d", subtitle, *o.TopScore, o.CandidateCount)
	}
	return subtitle
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
		// The same triage transitions the food half offers, driven by this
		// item's own status. feedback.Status and resolveoutcome.Status share
		// the open/in_progress/resolved/closed vocabulary, so one mapping
		// serves both kinds — and if they ever diverge, the status strings
		// stop matching and this returns an empty list rather than offering
		// an action the write side would refuse.
		Actions: actionsFor(string(f.Status)),
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
