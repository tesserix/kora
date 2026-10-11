package platformadmin

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

// defaultAIMetricsWindow bounds the window when the caller names neither
// from nor to. A page with no time bound at all would scan every outcome
// ever recorded on every request, and a default is safer to pick here than
// to force onto every fan-out caller.
const defaultAIMetricsWindow = 24 * time.Hour

// outcomesSection is #4.1's "outcomes" block: the resolver's own answer to
// "does resolution work", over the window. This is the number the platform's
// AI gateway ledger structurally cannot compute: cache hits, alias
// short-circuits, budget refusals and blank transcripts never reach a
// provider, so they never reach the ledger at all, and the ledger has no way
// to know whether a call that DID reach a provider was a first-try success
// or a correction paying off after the fact.
type outcomesSection struct {
	Attempts int64 `json:"attempts"`
	// ByKind carries all ten kinds always, zero-filled for any that did not
	// occur in the window — resolveoutcome.Rates.ByKind omits kinds that
	// didn't occur, and rendering that gap verbatim would let a kind vanish
	// from the console's chart rather than show as zero.
	ByKind     map[string]int64 `json:"by_kind"`
	NeedsHuman int64            `json:"needs_human"`
	// FirstTryRatePct is a pointer so an empty window is absent from the
	// JSON rather than rendered as 0.0. resolveoutcome.Rates.FirstTryRate
	// returns ok=false when its denominator (attempts, excluding cache and
	// alias hits) is zero — "we measured nothing" — and collapsing that into
	// 0.0 would read as "we measured this and the resolver failed every
	// time", which is the opposite of true and the exact defect #507 exists
	// to avoid. json's omitempty on a *float64 omits only a nil pointer, so a
	// genuine 0% rate (attempts > 0, zero first-try successes) still renders.
	FirstTryRatePct *float64 `json:"first_try_rate_pct,omitempty"`
}

// windowSection is the [from, to] bound the response was computed over
// (inclusive on both ends — the underlying queries use created_at <= to, not
// <), so the console never has to guess what "the window" meant for a given
// call.
type windowSection struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// userAIMetric is one user's row in #4.1's "users" section. Counts only,
// matching user.AdminDetail's posture — no food logs, no coach turns, no
// target_* value, no firebase_uid, no email. Nothing here widens that.
type userAIMetric struct {
	UserID         string `json:"user_id"`
	Attempts       int64  `json:"attempts"`
	Resolves       int64  `json:"resolves"`
	Corrections    int64  `json:"corrections"`
	BudgetRefusals int64  `json:"budget_refusals"`
	// AICalls counts ai_usage_events rows IN THIS SAME WINDOW, not actions
	// and not a lifetime total: one user tap can emit several rows when a
	// fallback leg is abandoned, and every other figure on this row is
	// bounded by [window.from, window.to], so this one must be too. It
	// deliberately does not filter to outcome='ok' — mirroring
	// user.ListForAdmin's ai_calls — because a user with AI calls and zero
	// resolved foods is the most actionable row on this page, and a
	// success-only count would erase them.
	AICalls int64 `json:"ai_calls"`
	// LastActivityAt is nullable: it renders only when the user has an
	// outcome at all.
	LastActivityAt *string `json:"last_activity_at,omitempty"`
}

// aiMetricsData is the whole "data" object §4.1's envelope wraps, for the
// default request — both sections.
type aiMetricsData struct {
	Window   windowSection   `json:"window"`
	Outcomes outcomesSection `json:"outcomes"`
	// Users is allocated with make even when empty — never left nil — so it
	// marshals as [] and not null (§4.1).
	Users []userAIMetric `json:"users"`
}

// aiMetricsOutcomesOnlyData is the "data" object for sections=outcomes: the
// window and the aggregate, and nothing else.
//
// This is a separate type rather than aiMetricsData with `users,omitempty`
// on purpose. omitempty on a slice drops it whenever it is nil OR empty —
// but the default (both-sections) response must keep rendering `"users":[]`
// on an empty page, never omit it (see the make() note above). One field
// tag cannot mean "omit when the caller didn't ask" on one path and "never
// omit, even when empty" on the other, so the two shapes get two types.
type aiMetricsOutcomesOnlyData struct {
	Window   windowSection   `json:"window"`
	Outcomes outcomesSection `json:"outcomes"`
}

// aiMetricsSections is which of #4.1's two blocks a caller asked for via
// ?sections=. The zero value means "both" — the endpoint's original,
// unchanged behaviour — so a Query built without going through
// parseAIMetricsSections (there is no such caller today, but nothing
// prevents one) still gets the safe, existing default rather than silently
// dropping the per-user section.
type aiMetricsSections struct {
	users bool
}

// parseAIMetricsSections reads ?sections= and decides whether
// ListUserAIMetrics — the expensive half of this endpoint and the half that
// enumerates active user UUIDs — should run at all.
//
// This is Kora's own convention, invented for this issue: neither Kora nor
// the Product Admin Integration Contract has an existing partial-response
// parameter today. ai-metrics is Kora's own endpoint, not one the contract
// defines, so this does not bind any other product-admin route, and no
// other route should copy this shape without its own review.
//
// Only one value is recognised right now: sections=outcomes. A
// comma-separated list (e.g. "outcomes,users") is deferred rather than
// built — there is exactly one section worth withholding today (the other
// is "everything"), and generalising to a list before a second caller
// exists is the field-selection framework this issue said not to build.
//
// Absent or unrecognised values take the default of "both", matching
// parseQuery's own never-fail posture and for the same reason: a caller
// that sends `sections=banana` (a typo, an old client, a future value this
// build predates) must get today's full response, not a 400 or a silently
// narrowed one. The console's Outcomes tab and every other current caller
// asks for nothing on this parameter, so they are unaffected either way.
func parseAIMetricsSections(c *gin.Context) aiMetricsSections {
	if strings.TrimSpace(c.Query("sections")) == "outcomes" {
		return aiMetricsSections{users: false}
	}
	return aiMetricsSections{users: true}
}

// AIMetricsRatesSource reads the resolver's outcome rates for a window.
// Satisfied by resolveoutcome.Repository; an interface so the handler is
// testable without a database.
type AIMetricsRatesSource interface {
	Between(ctx context.Context, from, to time.Time) (resolveoutcome.Rates, error)
}

// AIMetricsUserSource reads the paged per-user aggregate. Satisfied by this
// package's own Repository.
type AIMetricsUserSource interface {
	ListUserAIMetrics(ctx context.Context, q Query) (UserAIMetricsResult, error)
}

// AIMetricsHandler serves GET /admin/ai-metrics.
type AIMetricsHandler struct {
	rates  AIMetricsRatesSource
	users  AIMetricsUserSource
	logger *slog.Logger
	now    func() time.Time
}

// NewAIMetricsHandler builds the handler. logger may be nil. The user source
// is built from db directly, the same way NewRepository backs every other
// handler in this package.
func NewAIMetricsHandler(rates AIMetricsRatesSource, db *gorm.DB, logger *slog.Logger) *AIMetricsHandler {
	return &AIMetricsHandler{rates: rates, users: NewRepository(db), logger: logger, now: time.Now}
}

// Metrics handles GET /admin/ai-metrics?from=&to=&page=&limit=.
//
// No money on this endpoint. Cost is the gateway's own figure and belongs to
// #508, not here.
func (h *AIMetricsHandler) Metrics(c *gin.Context) {
	now := h.now().UTC()
	q := parseQuery(c, now)

	// parseQuery leaves From/To at their zero value when the caller names
	// neither — audit-logs and entities both treat that as "unbounded" for a
	// filter predicate, but a window this handler REPORTS BACK (window.from,
	// window.to) needs concrete instants, not the zero time. Defaulting here,
	// once, keeps that concrete-instant guarantee local to this handler
	// rather than pushed onto Between and ListUserAIMetrics, which still
	// treat a zero bound as legitimately unbounded for any caller that wants
	// that.
	to := q.To
	if to.IsZero() {
		to = now
	}
	from := q.From
	if from.IsZero() {
		from = to.Add(-defaultAIMetricsWindow)
	}

	ctx := c.Request.Context()

	rates, err := h.rates.Between(ctx, from, to)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: ai-metrics rates", "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not read resolution rates")
		return
	}

	sections := parseAIMetricsSections(c)
	if !sections.users {
		// Skip ListUserAIMetrics ENTIRELY — do not call it and discard the
		// result. That query is both the expensive half of this endpoint and
		// the sensitive half (it enumerates active user UUIDs), and the
		// governing rule from the platform-agent MCP design is that a
		// narrower principal must cause a narrower QUERY, never a narrower
		// serialization: data filtered after retrieval has already crossed
		// into the caller's logs, traces and memory.
		//
		// Also deliberately NOT using page(): rendering `"users":[]` with
		// `"pagination":{"total":0,...}` would assert there are zero active
		// users when we simply did not ask — the same absent-vs-zero
		// distinction this handler already enforces for
		// first_try_rate_pct (see outcomesSection's doc comment, and #507).
		// §4.1's envelope must not imply a collection nobody requested, so
		// both `users` and `pagination` are omitted outright rather than
		// zeroed.
		c.JSON(http.StatusOK, gin.H{"data": aiMetricsOutcomesOnlyData{
			Window:   windowSection{From: stamp(from), To: stamp(to)},
			Outcomes: toOutcomesSection(rates),
		}})
		return
	}

	result, err := h.users.ListUserAIMetrics(ctx, Query{From: from, To: to, Page: q.Page, Limit: q.Limit})
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: ai-metrics users", "err", err)
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not read per-user resolution activity")
		return
	}

	data := aiMetricsData{
		Window:   windowSection{From: stamp(from), To: stamp(to)},
		Outcomes: toOutcomesSection(rates),
		Users:    toUserAIMetrics(result.Rows),
	}

	page(c, data, Pagination{Page: q.Page, Limit: q.Limit, Total: result.Total})
}

// toOutcomesSection zero-fills every kind resolveoutcome.AllKinds declares,
// so a kind that did not occur in the window still appears as a zero rather
// than vanishing from the console's chart.
func toOutcomesSection(rates resolveoutcome.Rates) outcomesSection {
	byKind := make(map[string]int64, len(resolveoutcome.AllKinds))
	for _, k := range resolveoutcome.AllKinds {
		byKind[string(k)] = rates.ByKind[k]
	}

	out := outcomesSection{
		Attempts:   rates.Attempts,
		ByKind:     byKind,
		NeedsHuman: rates.NeedsHuman,
	}
	if pct, ok := rates.FirstTryRate(); ok {
		out.FirstTryRatePct = &pct
	}
	return out
}

func toUserAIMetrics(rows []UserAIMetricsRow) []userAIMetric {
	out := make([]userAIMetric, 0, len(rows))
	for _, row := range rows {
		um := userAIMetric{
			UserID:         row.UserID.String(),
			Attempts:       row.Attempts,
			Resolves:       row.Resolves,
			Corrections:    row.Corrections,
			BudgetRefusals: row.BudgetRefusals,
			AICalls:        row.AICalls,
		}
		if row.LastActivityAt != nil {
			s := stamp(*row.LastActivityAt)
			um.LastActivityAt = &s
		}
		out = append(out, um)
	}
	return out
}
