# Design — Kora in the tesserix-home admin portal

Date: 2026-08-05. Touches three repos: `tesserix-home` (the portal), `kora`
(new gauges, later an admin API), `tesserix-k8s` (config/secrets, later).

**Written as a handoff.** A session picking this up will not have the
reconnaissance that produced it, so the integration facts are recorded here
rather than left to be re-derived. Verify anything load-bearing before relying
on it — several of these were wrong in the docs and only settled by reading the
live system.

## Purpose

An **operating surface**: the thing you check when something feels wrong, or
before a release. Not a pricing dashboard (that is Phase 4) and not a support
console (Phase 3).

The motivation is concrete. Two real defects were found by hand-querying on
2026-08-04, both of which an operating surface would have surfaced immediately:

- The food index sat at **42% embedded (3,320 of 7,898) for the life of the
  project**, invisible because `cmd/embed` exits 0 when it gives up and the
  Kubernetes Job therefore reports `Complete`. See issue #97.
- `decompose` runs at **1,422 ms against a 1,500 ms `textBudget`** — 5%
  headroom. One slow call tips it into an abandoned leg and a paid fallback.

Neither is visible in any existing panel, and neither is something mark8ly or
homechef would ever need.

## Scope: four phases, not one feature

| Phase | What | Cost | Depends on |
|---|---|---|---|
| **1. Overview** | health + infra metrics + cost | small | nothing |
| **2. Logs** | Cloud Logging deep links | small | Phase 1 nav |
| **3. User management** | list/inspect/suspend accounts | **large** | a new admin API in kora |
| **4. Economics** | COGS/user, photo share, margin | medium | SQL rollups |

**Phase 1 is specified in full below. Phases 2–4 are scoped, not designed** —
each needs its own brainstorm before implementation. Phase 1 deliberately goes
first because it establishes the `ProductConfig`, routing, nav and registry
plumbing that all three others build on.

---

# Phase 1 — Overview

## What it shows

```
Kora / Overview

  Food index    3,820 / 7,898 embedded   ⚠ 4,078 missing
  AI calls 24h  122   · 0 errors · 0 timeouts
  Budget risk   decompose p99 1,422ms / 1,500ms  ⚠
  Resources     cpu · mem · pods
  Database      kora-postgres  41MB · lag
  Cost (30d)    AI spend · infra
```

Resources, Database, Cost and Email come free from the existing
`ProductOverviewLayout`. Food index, AI calls and Budget risk are new and
Kora-specific.

## Data source: Prometheus only

**Decision: extend the Kora exporter with gauges. tesserix-home gets no new
backend code and no new authenticated surface.**

The exporter shipped in kora#93 already exposes counters and a latency
histogram on `:9090`, scraped by GCP Managed Prometheus via the `PodMonitoring`
in tesserix-k8s#152. The AI-call and budget-risk panels are PromQL over what is
already there. Only the food-index numbers are missing, because they are a
question about **database state** rather than about events this process
observed — which is exactly why the exporter's design excluded them.

The decisive advantage over an HTTP admin endpoint is **alerting**: a gauge can
page someone. A number rendered in a portal only helps if a human happens to
look, and the 42%-embedded failure is precisely the case where nobody did.

### New gauges in `kora-api`

```
kora_food_index_items      7898   # total rows in food_items
kora_food_index_embedded   3820   # embedding IS NOT NULL
kora_food_index_missing    4078   # embedding IS NULL
```

Refreshed on a timer (60s is ample; this changes only when the embed job runs)
by a single query, not three:

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM food_items;
```

`missing` is derived, so the three can never disagree with each other.

Implementation notes for whoever builds it:

- Put the refresher behind the same `internal/metrics` package boundary. It
  takes a `*gorm.DB` and a ticker; it must not import `nutrition` or `foodlog`.
- **It must not crash or block startup if the query fails.** Log and leave the
  gauges at their last value. Observability failing must never take down the
  product — the same rule `cmd/api/main.go` already applies to the metrics
  listener, which deliberately does not `os.Exit`.
- Gauges are `Set`, not `Add`. A restart re-reads truth from the database, so
  unlike the counters there is no reset semantics to reason about.
- One test that matters: the refresher sets all three gauges from one query,
  and `missing == items - embedded` by construction. Mutation-verify it.

### PromQL for the panels

```promql
# AI calls, last 24h, by outcome
sum by (outcome) (increase(kora_ai_calls_total[24h]))

# Budget risk: share of decompose calls over the 1.5s textBudget
1 - (
  sum(rate(kora_ai_latency_seconds_bucket{call_type="decompose",le="1.5"}[24h]))
  /
  sum(rate(kora_ai_latency_seconds_count{call_type="decompose"}[24h]))
)

# Food index completeness
kora_food_index_embedded / kora_food_index_items
```

The histogram buckets were deliberately aligned to the router's budgets
(`1.5` = `textBudget`, `20` = `photoBudget`, `30` = `transcribeBudget`,
`100` = the Istio `perTryTimeout`), so "is the fast path missing its budget?"
is a read off a bucket boundary rather than an estimate. Do not "tidy" the
buckets to the library defaults.

## Portal integration

### The `ProductConfig` entry

`tesserix-home/apps/web/lib/products/configs.ts`. Model it on the `devai` entry
(single service, no billing) rather than `mark8ly` (which carries subscriptions
and row-count tables Kora does not have).

```ts
const kora: ProductConfig = {
  id: "kora",
  name: "Kora",
  namespace: "kora",
  cnpgClusterName: "kora-postgres",
  sendGridProductTag: "kora",
  rowCountTables: [],
  costAttribution: { requests: 0.5, storage: 0.3, egress: 0.2 },
  businessKpiTiles: [],
  // no pricingByPlan — the billing section auto-hides
};
```

**`cnpgClusterName: "kora-postgres"` is only correct as of 2026-08-04.** Before
that Kora ran on the shared `global-postgres`, and pointing this at that shared
cluster would have made the DB panels report four other products' figures
labelled as Kora's. The dedicated cluster exists now; do not repoint this at
`global-postgres`.

### Routing, nav and registry — all hand-edits

The portal claims adding a product is "a config-only change". **It is not.**
Verified by reading the code:

1. `apps/web/app/admin/apps/kora/page.tsx` — a six-line wrapper rendering
   `<ProductOverviewLayout config={getProductConfig("kora")} />`.
2. `apps/web/components/admin/sidebar.tsx` — a `koraNav` array, a `"kora"`
   value in `RailContext`, and branches in `getActiveContext()` and
   `getSecondaryNav()`. The left icon rail is **hardcoded per product**, so a
   rail entry and a `/kora-icon.png` in `apps/web/public/` are separate edits.
   Note DevAI has nav but no rail icon — an existing inconsistency, not a
   pattern to copy.
3. A migration under `apps/web/db/migrations/` inserting a `kora` row into the
   `apps` table, which drives the `/admin/apps` grid. Copy
   `0013_seed_devai_app.sql`; it is the cleanest recent single-service example.
   **Use an idempotent migration, not `db/seeds/apps.sql`** — that file is not
   auto-applied, and a re-seed once silently dropped HomeChef's tile.

The rail icon already exists: `kora/apps/mobile/assets/brand/kora-rail-64.png`,
generated from the mark added in kora#94. Copy it in deliberately rather than
referencing across repos.

## Out of scope for Phase 1

- **Any write action.** Read-only. Writes need the admin API of Phase 3.
- **Per-user anything.** Prometheus has no `user_id` label, by design —
  unbounded cardinality on a Managed Prometheus bill. `ai_usage_events` stays
  authoritative for per-user questions; see `docs/ai-usage-queries.md`.
- **A Grafana dashboard.** The portal is the surface here.

---

# Phases 2–4 — scoped, not designed

## Phase 2 — Logs

> **SUPERSEDED 2026-08-05 — this section's premise is factually wrong.**
> GKE logging is **disabled** on the cluster (`loggingConfig.componentConfig: {}`),
> and Cloud Logging has never ingested a container log line from it. The deep
> links below would have pointed at an empty dataset. Decision recorded in
> `2026-08-05-kora-logs-not-building-decision.md`: not building this; audit
> events (`kora_admin_events`, from the food-data design) serve the need
> instead. The rest of this section is retained only as the original reasoning.

**Recommendation: deep links into Cloud Logging, pre-filtered.** GKE already
ships container logs there, the API logs structured JSON, and a link costs
almost nothing to build. An in-portal viewer with search and tailing is a real
project that duplicates something Google does better.

A filter for `resource.labels.namespace_name="kora"` and the `kora-api`
container, plus one for `severity>=ERROR`, covers most of what an operator
wants. Worth revisiting only if it turns out people won't leave the portal.

## Phase 3 — User management

**The heavy one, and the long pole.** It needs, in kora: `bff_auth`
HMAC-SHA256 middleware mirroring `homechef-api/apps/api/middleware/bff_auth.go`
(which binds method, path, body hash, timestamp and caller identity into the
MAC), admin endpoints, and a `KORA_BFF_HMAC_KEY` in GCP Secret Manager. In the
portal: `lib/api/kora-admin.ts` mirroring `lib/api/homechef-admin.ts`.

### Which access pattern — discussed 2026-08-05, decided by read/write split

Two patterns exist in the portal:

- **mark8ly, "federated read":** tesserix-home opens a direct Postgres
  connection into the product's namespace as `<product>_platform_admin` and
  runs raw SQL, including writes. Needs an Istio cross-namespace egress rule, a
  DB role and an ExternalSecret; needs nothing from the product. Runbook:
  `tesserix-k8s/docs/cross-db-admin.md`.
- **homechef, signed BFF:** the portal calls the product's own HTTP admin API
  as a trusted caller, HMAC-SHA256 over method/path/body/identity. Documented
  as the successor — `lib/api/homechef-admin.ts` says "No direct DB" outright.

**Decision: split by read vs write.**

- **Reads** (list users, inspect an account, log counts) — direct DB is
  defensible and cheap. A read-only role cannot corrupt anything.
- **Writes** (suspend, delete, anything mutating) — **must** go through Kora's
  API.

The reason is specific to Kora rather than stylistic. Kora keeps a **Redis
resolve cache keyed by user** (`CacheKey("voice", userID, …)`), and `foodlog`
carries idempotency invariants the offline queue (#22) depends on. A direct SQL
write leaves per-user cache entries stale with nothing to evict them: the
portal would look like it worked while Kora went on serving stale resolutions.
The mark8ly runbook effectively concedes this — it instructs operators to
hand-write `audit_events` rows precisely because direct writes skip the
product's own side effects.

The fit argument points the same way. Mark8ly is ~30 services, so a portal-side
SQL join genuinely beat orchestrating HTTP. Kora is **one Go service, exactly
like HomeChef**.

**Practical consequence:** if Phase 3 ships read-only, take the mark8ly route
and skip the BFF entirely. The moment it needs one write, build the BFF and put
*everything* through it — once it exists, routing reads over it too is nearly
free, and maintaining two access paths is not worth it.

**Worth stating plainly: Kora has 5 users and 3 food logs.** This phase has the
highest build cost and the least present-day value. It is also the one that
cannot be retrofitted in an afternoon when it is finally needed, so the
question is timing, not whether.

## Phase 4 — Economics

Per-user aggregates — median AI calls per active user, Σ cost per user, photo
share of logs, margin at candidate prices. Gates #41. **Prometheus cannot
answer these**, deliberately, so this is SQL rollups over `ai_usage_events` and
`food_logs`.

Read `docs/ai-usage-queries.md` first. The filtering rule is not intuitive and
has already been got wrong twice: resource questions (spend, quota) count every
row because failed calls still consume billed tokens and quota; product
questions (calls/user, photo share) must filter `outcome = 'ok'`.

Two traps recorded there apply directly: every row before 2026-08-04 is
`outcome = 'ok'` by construction, so a reliability query spanning that boundary
reports a fake 100% success rate; and one user action can be several rows when
a fallback leg is abandoned, so per-user *call* counts are not per-user
*action* counts.

Also relevant: `cmd/embed` discards the `Usage` it receives, so the food
index's embedding spend appears in neither `ai_usage_events` nor the exporter.
"Total COGS = resolution + derived" is false at the org level until that is
fixed (#97).

---

## Facts a new session should not re-derive

Each of these was established by reading the live system or the source, and
several contradict the documentation:

- **Resources and Cost are already product-agnostic.** `getProductMetrics`
  fans out to Prometheus and OpenCost keyed only on `namespace` and
  `cnpgClusterName`, with per-section `try/catch` so one failing upstream
  degrades a panel to `"—"` rather than failing the page.
- **Nav is not table-driven.** Only the `/admin/apps` grid is; the sidebar,
  rail and mobile switcher are hand-written per product.
- **`ai_usage_events` as of 2026-08-04**: `identify_text` 30 calls (avg 939ms,
  max 1302ms), `decompose` 15 (avg 997, max 1422), `embed` 77 (avg 428),
  `identify_photo` 2 (avg 12799, max 13438). Zero `error` or `timeout` rows.
  `transcribe` and `coach` have **never** recorded a call.
- **The 20s `photoBudget` is correctly sized** — 13.4s observed max.
- **Kora's database is `kora-postgres` in namespace `kora`** (CloudNativePG,
  provisioned 2026-08-04), not the shared `global-postgres`, and not Cloud SQL
  as the workspace `CLAUDE.md` claims.
- **Never trust a Kubernetes Job's status for the embed job.** It reports
  `Complete` having done 11%, or 0%, of the work (#97).
