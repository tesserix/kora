package platformadmin

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Dependency status values.
//
// `unknown` and `not_instrumented` are separate on purpose: "we looked and
// the lookup broke" and "we did not look" are different facts about the
// system, and collapsing either into `ok` converts an outage into a green
// tile. This is kora#420's lesson — "cannot read" and "nothing to report"
// must never share a value.
//
// There is deliberately no `degraded`. Every probe Kora runs is binary —
// Postgres and Redis either answer or they do not — so a value nothing can
// ever produce would be vocabulary pretending to be a state. mark8ly has one
// because it measures queue depths against thresholds; add it here when Kora
// measures something that can be partly wrong.
const (
	StatusOK              = "ok"
	StatusDown            = "down"
	StatusUnknown         = "unknown"
	StatusNotInstrumented = "not_instrumented"
)

// probeTimeout bounds every dependency check. /admin/health is called by a
// fan-out across the estate; a dependency that accepts a connection and never
// answers must not hold the console's page open.
const probeTimeout = 2 * time.Second

// Dependency names, as they appear on the wire.
const (
	DepPostgres    = "postgres"
	DepRedis       = "redis"
	DepAIProvider  = "ai_provider"
	DepFoodBacklog = "unresolved_food_backlog"
	DepAIBudget    = "ai_budget"
)

// dependencyKey is one dependency the console may be told about.
type dependencyKey struct {
	Name string
	// Instrumented is whether Kora actually probes this. A false entry
	// reports not_instrumented — it is never omitted and never `ok`.
	Instrumented bool
}

// DependencyRegistry declares EVERY dependency Kora knows about and drives
// the payload. The handler does not decide membership with conditionals, so a
// dependency cannot fall silently out of the response.
//
// The one uninstrumented entry is honest, not lazy:
//
//   - ai_provider: prod is gateway→Vertex, and the only genuine probe is a
//     model call, which costs money and quota on every console page render.
//     Configuration presence is NOT health — a set GEMINI_API_KEY says a
//     deploy was configured and nothing more — so there is nothing here that
//     could be reported without lying.
//
// unresolved_food_backlog became instrumented with kora#459: the outcome
// table exists, so the depth is a COUNT rather than an invention.
//
// Adding an entry here without a probe below yields `unknown`, not `ok` —
// see the emit loop.
var DependencyRegistry = []dependencyKey{
	{Name: DepPostgres, Instrumented: true},
	{Name: DepRedis, Instrumented: true},
	{Name: DepAIProvider, Instrumented: false},
	{Name: DepFoodBacklog, Instrumented: true},
	{Name: DepAIBudget, Instrumented: true},
}

// Probe is one genuinely-performed dependency check.
//
// It returns an error when the dependency is unreachable, and an error from
// the CHECK ITSELF is indistinguishable from that on purpose: both mean "not
// known to be working", and the honest answer to both is not `ok`.
//
// The map is what the product knows ABOUT that dependency and nothing else
// can see — §3.5's "its own queue depths". Nil is the ordinary case: Postgres
// and Redis either answer or they do not, and there is no number to report.
// A probe that returns a map on failure has its numbers discarded, because a
// count from a check that errored is not a measurement.
type Probe func(ctx context.Context) (map[string]int64, error)

// dependencyRow is one entry in the response.
type dependencyRow struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	// Metrics is omitempty so an uninstrumented or unknown dependency ships no
	// metrics key at all. A zeroed block would be indistinguishable from a
	// healthy one reporting genuine zeroes — the same distinction `unknown`
	// draws for status.
	Metrics map[string]int64 `json:"metrics,omitempty"`
	// Detail is a short, non-sensitive reason for a non-ok status. It never
	// carries the driver error — DSN fragments and host names do not leave
	// the process; the real error goes to the log.
	Detail string `json:"detail,omitempty"`
}

// HealthHandler serves GET /admin/health — "is this product working", as
// distinct from /health (is the process alive) and /ready (can it serve).
// Those two are correctly scoped and unchanged.
type HealthHandler struct {
	probes map[string]Probe
	logger *slog.Logger
	now    func() time.Time
}

// NewHealthHandler builds the handler. probes is keyed by dependency name;
// a registry entry marked Instrumented with no probe here reports `unknown`,
// which is the correct answer to "registered as measured, never measured".
func NewHealthHandler(probes map[string]Probe, logger *slog.Logger) *HealthHandler {
	return &HealthHandler{probes: probes, logger: logger, now: time.Now}
}

// Health handles GET /admin/health.
func (h *HealthHandler) Health(c *gin.Context) {
	asOf := h.now()

	rows := make([]dependencyRow, 0, len(DependencyRegistry))
	for _, key := range DependencyRegistry {
		rows = append(rows, h.check(c.Request.Context(), key))
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"checked_at":   stamp(asOf),
		"dependencies": rows,
	}})
}

// check runs one registry entry's probe.
//
// The endpoint itself is always 200: it reports health, it does not have
// health. A 503 here would make "Kora says Redis is down" and "Kora's health
// endpoint is down" the same event to the console, which is the one
// distinction this endpoint exists to draw.
func (h *HealthHandler) check(ctx context.Context, key dependencyKey) dependencyRow {
	if !key.Instrumented {
		return dependencyRow{Name: key.Name, Status: StatusNotInstrumented}
	}

	probe, ok := h.probes[key.Name]
	if !ok || probe == nil {
		// Registered as instrumented, but nothing measures it — a wiring
		// mistake, not a runtime condition. `unknown` says so; `ok` would
		// hide it forever.
		return dependencyRow{Name: key.Name, Status: StatusUnknown,
			Detail: "no probe is wired for this dependency"}
	}

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	metrics, err := probe(probeCtx)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("platformadmin: dependency probe failed",
				"dependency", key.Name, "err", err)
		}
		// Metrics deliberately dropped: a count produced by a check that
		// errored is not a measurement, and shipping it beside a `down`
		// status invites reading it as one.
		return dependencyRow{Name: key.Name, Status: StatusDown, Detail: "probe failed"}
	}
	return dependencyRow{Name: key.Name, Status: StatusOK, Metrics: metrics}
}
