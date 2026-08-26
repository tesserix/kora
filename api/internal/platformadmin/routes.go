package platformadmin

import (
	"context"
	"log/slog"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/platformauth"
	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

// Deps is everything Register needs from main.
type Deps struct {
	DB *gorm.DB
	// Secret is the HMAC key the platform console signs with. Empty means the
	// surface is not mounted at all — see Register.
	Secret string
	// Probes are the genuinely-performed dependency checks behind
	// GET /admin/health, keyed by dependency name. A name in
	// DependencyRegistry with no probe here reports `unknown`, never `ok`.
	Probes map[string]Probe
	Logger *slog.Logger
}

// Register mounts the contract surface under /v1/admin.
//
// # Why /v1/admin and not /admin
//
// The federation client calls `{BaseURL}/admin/<endpoint>` and signs the
// DECODED request path, which includes whatever prefix BaseURL carries. Kora
// mounts every route under /v1, so the registered BaseURL must end in "/v1"
// and the signed path is "/v1/admin/audit-logs". An unversioned alias was the
// alternative and was rejected: it would mean two paths for one endpoint,
// only one of which the signature covers, and a caller landing on the wrong
// one gets an opaque 401 with nothing in Kora's logs to explain it.
//
// # Why a second group on the same prefix
//
// /v1/admin already carries bffauth for the tesserix-home admin portal. These
// routes carry platformauth instead, because the two callers sign
// incompatible canonical strings (see package platformauth's doc). Gin's
// radix tree keeps the paths distinct — `events` and `audit-logs` are
// different children of the same node — so the two groups coexist without
// either middleware seeing the other's traffic. Do NOT move a route between
// the groups without moving its caller.
//
// An empty Secret mounts nothing, so an unconfigured environment answers 404
// rather than 401 — the same choice the bffauth group makes, and the
// difference matters when diagnosing a deployment.
func Register(r *gin.Engine, deps Deps) {
	if deps.Secret == "" {
		return
	}

	repo := NewRepository(deps.DB)
	outcomes := resolveoutcome.NewRepository(deps.DB)

	// The unresolved-food backlog probe (#434). Registered here rather than
	// left to main because the depth is a query on the same DB this package
	// already holds — the same reasoning the Postgres probe follows.
	probes := make(map[string]Probe, len(deps.Probes)+1)
	for name, probe := range deps.Probes {
		probes[name] = probe
	}
	probes[DepFoodBacklog] = func(ctx context.Context) (map[string]int64, error) {
		depth, err := outcomes.BacklogDepth(ctx)
		if err != nil {
			return nil, err
		}
		// The depth is the point. #459's health consumer is exactly this
		// COUNT, and a backlog that only ever reports "reachable" would say
		// nothing about whether anyone is keeping up with it.
		return map[string]int64{"waiting": depth}, nil
	}
	g := r.Group("/v1/admin", platformauth.Middleware(platformauth.Config{
		Secret: deps.Secret,
		Nonces: platformauth.NewNonceStore(deps.DB),
		Logger: deps.Logger,
	}))

	g.GET("/audit-logs", NewAuditHandler(repo, deps.Logger).List)
	g.GET("/inbox", NewInboxHandler(repo, deps.Logger).
		WithUnresolvedFoods(outcomes).List)
	g.GET("/entities/:type", NewEntitiesHandler(repo, deps.Logger).Search)
	g.GET("/health", NewHealthHandler(probes, deps.Logger).Health)
	g.GET("/kpis", NewKPIsHandler().KPIs)

	// Not mounted, deliberately, so the absences are legible here rather than
	// only in an issue:
	//
	//   - GET /admin/billing/* (§8.2). Kora has no billing concept. §8.2 is
	//     explicit that a product with none implements none of them and must
	//     NOT return {} or an empty list — 404 from an unmounted route says
	//     "no such surface", which is the true answer.
	//   - POST /admin/inbox/{id}/actions/{actionId} (§8.3). The read side
	//     declares no actions, and §8.3 requires rejecting an action the item
	//     did not declare — so there is nothing this route could accept.
	//   - Every write (§8.3 domain writes). #447: the console is read-only
	//     for Kora. Foods and users are edited through Kora's own portal.
}
