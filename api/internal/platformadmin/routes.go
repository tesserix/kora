package platformadmin

import (
	"context"
	"log/slog"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/billing"
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
	// Agents mounts the registry diagnostics; nil leaves them unmounted.
	Agents *agents.Coordinator
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
	// The AI budget probe (kora#485). globalMonthlyCostCapUSD is a kill
	// switch on the whole product's AI, and until now the only way to read it
	// was to open meter.go. An operator watching spend climb on
	// /platform/ai-usage could see the number going up and not the ceiling it
	// was going up toward.
	//
	// READ ONLY. Changing a cap is a turn-the-product-off lever and needs the
	// §8.3 apparatus this package has deliberately not built; see billing.Caps.
	meter := billing.NewMeter(deps.DB)
	probes[DepAIBudget] = func(context.Context) (map[string]int64, error) {
		// Request ceilings only. The COST figures carry a currency and travel
		// on the money channel below, because §4.2 requires money to be an
		// { amount, currency } object and this map cannot express one.
		return billing.RequestCapMetrics(), nil
	}
	moneyProbes := map[string]MoneyProbe{
		DepAIBudget: func(ctx context.Context) (map[string]Money, error) {
			amounts, err := meter.BudgetMoney(ctx)
			if err != nil {
				return nil, err
			}
			out := make(map[string]Money, len(amounts))
			for k, v := range amounts {
				out[k] = Money{Amount: v.Amount, Currency: v.Currency}
			}
			return out, nil
		},
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
	g.GET("/health", NewHealthHandler(probes, deps.Logger).WithMoneyProbes(moneyProbes).Health)
	g.GET("/kpis", NewKPIsHandler().KPIs)
	// The food-resolution accuracy numbers the console's AI page needs
	// (kora#507). Deliberately Kora's own read: the platform's AI gateway
	// ledger cannot compute these because cache/alias/budget short-circuits
	// never reach a provider and the resolver's first-try judgement happens
	// after the provider answers, so neither trace is in the ledger's rows.
	g.GET("/ai-metrics", NewAIMetricsHandler(outcomes, deps.DB, deps.Logger).Metrics)
	// §8.3's execution endpoint. The read side declares actions per item and
	// this refuses any action that item did not offer, so the declared array
	// is a contract the console can render against (kora#484).
	g.POST("/inbox/:id/actions/:actionId", NewInboxActionHandler(repo, deps.Logger).Apply)

	if deps.Agents != nil {
		agentsHandler := agents.NewHandler(deps.Agents)
		g.GET("/agents", agentsHandler.List)
		g.GET("/agents/:name", agentsHandler.Get)
		g.POST("/agents/:name/refresh", agentsHandler.Refresh)
	}

	// Not mounted, deliberately, so the absences are legible here rather than
	// only in an issue:
	//
	//   - GET /admin/billing/* (§8.2). Kora has no billing concept. §8.2 is
	//     explicit that a product with none implements none of them and must
	//     NOT return {} or an empty list — 404 from an unmounted route says
	//     "no such surface", which is the true answer.
	//   - Domain writes beyond triage. #447 was reversed on 2026-08-27 — the
	//     console controls and manages Kora — but the triage actions mounted
	//     above are deliberately the whole of it for now. `resolve-to-food`
	//     and `add-alias` are NOT offered: a curated alias resolves at score
	//     1.0, the auto-log tier, so a wrong one silently logs the wrong food
	//     for every user. Those entries live in a reviewed data file where
	//     each carries a stated `why`, and a console button would remove the
	//     review rather than the work. Foods and users are still edited
	//     through Kora's own portal.
}
