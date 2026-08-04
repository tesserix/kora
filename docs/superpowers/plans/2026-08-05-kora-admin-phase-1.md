# Kora Admin Surface — Phase 1 (Overview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kora an operating surface in the tesserix-home admin portal — food-index completeness, AI call volume, AI failures and decompose budget risk — backed by new Prometheus gauges in `kora-api` and a working metrics data path from the cluster to the portal.

**Architecture:** Three independent parts. (A) `kora-api` gains three gauges refreshed on a 60s timer from one SQL query, exported on the existing `:9090` listener and scraped by the already-deployed GMP `PodMonitoring`. (B) A GMP `frontend` proxy is deployed so the portal has a Prometheus-HTTP-API endpoint that can actually read GMP data — the portal's current `PROMETHEUS_URL` points at a Service with zero endpoints. (C) tesserix-home gains a `ProductConfig`, a KPI route branch that runs four PromQL queries, a six-line page, hand-written nav/rail/mobile-switcher entries, and an apps-registry migration.

**Tech Stack:** Go 1.26 + GORM + prometheus/client_golang (kora-api); Next.js 16 + React 19 + SWR + vitest (tesserix-home); Helm + ArgoCD + GKE Managed Prometheus (tesserix-k8s); PostgreSQL.

## Global Constraints

- **Single-line conventional commits.** No body, no trailers, no signature. Squash merges.
- **Branch before committing — never commit to `main`** in any of the three repos.
- **Mutation-verify every test.** Break the behaviour the test names, confirm it fails *on that test's own assertion* (read the failure message — a false red becomes a false green the moment you fix the wrong thing), revert, confirm `git diff` is clean.
- **A one-sided assertion is a vacuous guard.** Every "must not X" needs its "must X" twin, or the mechanism can be deleted with the suite still green.
- **A skipped test proves nothing.** Any test guarded by `t.Skipf("postgres unavailable")` must be observed *running*, not skipping. Check the verbose output for `--- PASS`, never a bare `ok`.
- **Do not touch `latencyBuckets`** in `api/internal/metrics/metrics.go:27`. `1.5`/`20`/`30`/`100` are `textBudget`/`photoBudget`/`transcribeBudget`/Istio `perTryTimeout`. The budget panel reads off those boundaries.
- **`cnpgClusterName` for Kora is `kora-postgres`**, never `global-postgres`. Kora got a dedicated CloudNativePG cluster on 2026-08-04; the shared one would report four other products' figures as Kora's.
- **Never trust a Kubernetes Job's status or ArgoCD "Synced/Healthy" as evidence.** Verify row counts, running image digests, and `.status.sync.revision` against git HEAD. Force a refresh with `kubectl -n argocd annotate application <app> argocd.argoproj.io/refresh=hard --overwrite`.
- **Run tests in the foreground.** Never background a test command.
- `gh pr merge` is sometimes denied by the permission classifier. If denied, ask Mahesh to run it with a leading `!` rather than working around it.

## Verified Ground Truth (established 2026-08-05, do not re-derive)

- **kora CI works.** `build-image` succeeded on `495c482`; every merge to `main` pushes `ghcr.io/tesserix/kora/kora-api:<sha>` (`.github/workflows/ci.yml:71-76`). Manual `docker buildx` is **not** needed.
- **Deploying is a one-line ArgoCD change, not a git change.** `argocd/prod/apps/kora-app-of-apps.yaml:23-27` sets `ignoreDifferences` on `/spec/source/helm/parameters` deliberately (so image promotion isn't reverted), so patching `image.tag` on the live `kora-api` Application is durable against `selfHeal`. Git says `"latest"` and that is intentional.
- **tesserix-k8s CI has been dead since 2026-08-03** (~2s failures, no runner assigned). It does **not** gate ArgoCD, and PRs #153/#157 were merged with it red.
- **The portal's Prometheus is a black hole.** `deploy/company` in ns `tesserix` has `PROMETHEUS_URL=http://prometheus-server.monitoring`; that Service has **zero endpoints** (`replicas=0`). Every Prometheus-backed panel — Resources and Database, for *all* products — renders `—` today. Part B fixes this.
- **GMP is alive and ingesting** (`prometheus.googleapis.com/container_*`, `kube_*` descriptors exist) but has **zero `cnpg_*` and zero `kora_*`** descriptors. There is no `gmp-system` namespace and no GMP `frontend` deployed.
- **Running pod is `8b6e961` (pre-exporter)** and refuses `:9090` (`connection refused`), confirming the exporter has never run in prod.
- **Food index right now: 7,898 total / 3,820 embedded / 4,078 missing.** An embed backfill Job ran and reported `Completed` while moving the count by zero — issue #97's false green, re-confirmed live. This is the number Part A must make visible.
- **`businessKpiTiles` + `/api/admin/apps/[product]/kpis` is the extension point.** `product-overview-layout.tsx:113` maps the tiles; `resolveKpiValue` (:31) prefers the product KPI map keyed by `tile.key`. **No change to `product-overview-layout.tsx` is needed** — which is what keeps the page a six-line wrapper. The spec's `businessKpiTiles: []` sketch contradicts its own "What it shows" list; tiles are declared.
- **The rail asset exists:** `kora/apps/mobile/assets/brand/kora-rail-64.png`, 64×64 PNG. The rail renders it with `brightness-0 invert`, i.e. as a silhouette.
- **Next tesserix-home migration number is `0015`** (`0014_product_waitlist.sql` is last).
- **kora test DB:** `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable`, docker container `kora-pg-test` (currently up).

---

# Part A — kora-api food-index gauges

Repo: `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`. Branch: `feat/food-index-gauges` off `main`.

### Task 1: The gauges and their primitive setter

`internal/metrics` documents itself as accepting "only primitives, so it imports nothing from ai, billing or foodlog". Task 1 keeps that true: the setter takes two integers. Task 2 adds the DB-facing refresher in its own file and amends the package doc honestly rather than leaving a comment that has quietly become false.

**Files:**
- Modify: `api/internal/metrics/metrics.go` (add three gauges to `Collectors`, register them, add `SetFoodIndex`)
- Test: `api/internal/metrics/metrics_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `func (c *Collectors) SetFoodIndex(total, embedded int64)` — sets all three gauges from one call.
  - `func SetFoodIndex(total, embedded int64)` — package-level, on `defaultCollectors`.
  - `func (c *Collectors) FoodIndexGauges() (items, embedded, missing prometheus.Gauge)` — test accessor, mirroring the existing `AICallsCounter` / `FoodLogsCounter` idiom.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/metrics/metrics_test.go`. Note the pair: the first test is the positive twin (the gauges really carry the queried numbers), the second is the invariant. Neither alone is sufficient — with only the invariant test, `SetFoodIndex` could set all three to 0 and stay green.

```go
func TestSetFoodIndexSetsAllThreeGaugesFromOneCall(t *testing.T) {
	c := New()
	c.SetFoodIndex(7898, 3820)

	items, embedded, missing := c.FoodIndexGauges()
	if got := testutil.ToFloat64(items); got != 7898 {
		t.Errorf("items gauge = %v, want 7898", got)
	}
	if got := testutil.ToFloat64(embedded); got != 3820 {
		t.Errorf("embedded gauge = %v, want 3820", got)
	}
	if got := testutil.ToFloat64(missing); got != 4078 {
		t.Errorf("missing gauge = %v, want 4078", got)
	}
}

// missing is DERIVED, never queried, so the three can never disagree with
// each other. Checked across several shapes including the boundaries.
func TestFoodIndexMissingIsAlwaysItemsMinusEmbedded(t *testing.T) {
	cases := []struct{ total, embedded int64 }{
		{7898, 3820},
		{0, 0},
		{100, 100}, // fully embedded — missing must be 0, not absent
		{100, 0},   // nothing embedded
	}
	for _, tc := range cases {
		c := New()
		c.SetFoodIndex(tc.total, tc.embedded)
		items, embedded, missing := c.FoodIndexGauges()
		gotItems := testutil.ToFloat64(items)
		gotEmb := testutil.ToFloat64(embedded)
		gotMiss := testutil.ToFloat64(missing)
		if gotMiss != gotItems-gotEmb {
			t.Errorf("SetFoodIndex(%d,%d): missing=%v, want items(%v)-embedded(%v)=%v",
				tc.total, tc.embedded, gotMiss, gotItems, gotEmb, gotItems-gotEmb)
		}
	}
}

// Gauges are Set, not Add: a restart re-reads truth from the database, so a
// second refresh must REPLACE the previous reading, not accumulate onto it.
func TestSetFoodIndexReplacesRatherThanAccumulates(t *testing.T) {
	c := New()
	c.SetFoodIndex(7898, 3820)
	c.SetFoodIndex(7898, 7898)

	items, embedded, missing := c.FoodIndexGauges()
	if got := testutil.ToFloat64(embedded); got != 7898 {
		t.Errorf("embedded gauge after second set = %v, want 7898 (Set, not Add)", got)
	}
	if got := testutil.ToFloat64(missing); got != 0 {
		t.Errorf("missing gauge after second set = %v, want 0", got)
	}
	if got := testutil.ToFloat64(items); got != 7898 {
		t.Errorf("items gauge after second set = %v, want 7898", got)
	}
}
```

If `github.com/prometheus/client_golang/prometheus/testutil` is not already imported in this file, add it to the import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/metrics/ -run 'FoodIndex' -v`
Expected: FAIL to compile — `c.SetFoodIndex undefined` and `c.FoodIndexGauges undefined`.

- [ ] **Step 3: Write the implementation**

In `api/internal/metrics/metrics.go`, add three fields to `Collectors` (after `foodLogs`):

```go
	foodIndexItems    prometheus.Gauge
	foodIndexEmbedded prometheus.Gauge
	foodIndexMissing  prometheus.Gauge
```

In `New()`, after the `foodLogs` collector literal, add:

```go
		foodIndexItems: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "kora_food_index_items",
			Help: "Rows in food_items. A gauge, not a counter: refreshed from the database on a timer, so a restart re-reads truth rather than resetting to zero.",
		}),
		foodIndexEmbedded: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "kora_food_index_embedded",
			Help: "Rows in food_items with a non-NULL embedding. Resolution quality degrades silently as this falls behind kora_food_index_items — cmd/embed exits 0 when it gives up, so the Job reports Complete having done none of the work (#97).",
		}),
		foodIndexMissing: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "kora_food_index_missing",
			Help: "Rows in food_items with a NULL embedding. Derived as items-embedded from the same query, never counted separately, so the three can never disagree.",
		}),
```

Extend the `MustRegister` call:

```go
	c.registry.MustRegister(c.aiCalls, c.aiCostUSD, c.aiLatency, c.foodLogs,
		c.foodIndexItems, c.foodIndexEmbedded, c.foodIndexMissing)
```

Add the setter and accessor after `RecordFoodLog`:

```go
// SetFoodIndex publishes the food-index completeness gauges from ONE database
// reading. missing is derived rather than queried so the three can never
// disagree with each other.
func (c *Collectors) SetFoodIndex(total, embedded int64) {
	c.foodIndexItems.Set(float64(total))
	c.foodIndexEmbedded.Set(float64(embedded))
	c.foodIndexMissing.Set(float64(total - embedded))
}

// FoodIndexGauges exposes the three gauges for assertions in tests. Not used by
// production code.
func (c *Collectors) FoodIndexGauges() (items, embedded, missing prometheus.Gauge) {
	return c.foodIndexItems, c.foodIndexEmbedded, c.foodIndexMissing
}
```

And the package-level wrapper, next to `RecordFoodLog`:

```go
// SetFoodIndex publishes the food-index gauges on the default collectors.
func SetFoodIndex(total, embedded int64) { defaultCollectors.SetFoodIndex(total, embedded) }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/metrics/ -v`
Expected: PASS, including the three new `FoodIndex` tests and every pre-existing test in the package.

- [ ] **Step 5: Mutation-verify all three tests**

Do these one at a time, reverting between each. Read the failure message every time — the point is that it fails for the named reason, not merely that it fails.

1. Change `c.foodIndexMissing.Set(float64(total - embedded))` to `c.foodIndexMissing.Set(float64(embedded))`.
   Expected: `TestSetFoodIndexSetsAllThreeGaugesFromOneCall` fails on `missing gauge = 3820, want 4078`, and `TestFoodIndexMissingIsAlwaysItemsMinusEmbedded` fails on its own message. Revert.
2. Change `c.foodIndexEmbedded.Set(float64(embedded))` to `c.foodIndexEmbedded.Set(0)`.
   Expected: `TestSetFoodIndexSetsAllThreeGaugesFromOneCall` fails on `embedded gauge = 0, want 3820`. This is the mutation the invariant test alone would NOT catch — confirm the invariant test still passes under it, which is precisely why the positive twin exists. Revert.
3. Change all three `.Set(` calls to `.Add(`.
   Expected: `TestSetFoodIndexReplacesRatherThanAccumulates` fails on `embedded gauge after second set = 11718, want 7898`. Revert.

Confirm `git diff` is clean of every mutation before continuing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/metrics/metrics.go api/internal/metrics/metrics_test.go
git commit -m "feat(api): food index completeness gauges"
```

---

### Task 2: The refresher

**Files:**
- Create: `api/internal/metrics/foodindex.go`
- Create: `api/internal/metrics/foodindex_test.go`
- Modify: `api/internal/metrics/metrics.go:1-11` (package doc — the "only primitives" claim stops being true for this package)

**Interfaces:**
- Consumes: `Collectors.SetFoodIndex(total, embedded int64)` from Task 1.
- Produces:
  - `type FoodIndexRefresher struct{ ... }`
  - `func NewFoodIndexRefresher(db *gorm.DB, c *Collectors, interval time.Duration, logger *slog.Logger) *FoodIndexRefresher`
  - `func (r *FoodIndexRefresher) RefreshOnce(ctx context.Context) error` — one query, one `SetFoodIndex`; returns the query error without touching the gauges.
  - `func (r *FoodIndexRefresher) Run(ctx context.Context)` — blocks: refreshes immediately, then on each tick, until `ctx` is done.

- [ ] **Step 1: Write the failing tests**

Create `api/internal/metrics/foodindex_test.go`. Note the pairing: `TestRefreshOnceLeavesGaugesOnQueryFailure` is a "must not" and is worthless without `TestRefreshOncePublishesTheQueriedCounts`, its "must" twin — with only the failure test, a `RefreshOnce` that never sets anything would pass.

```go
package metrics

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// The positive twin. Reads the REAL count from food_items and asserts the
// gauges carry exactly it — so a RefreshOnce that queries correctly but never
// publishes, or publishes constants, fails here.
func TestRefreshOncePublishesTheQueriedCounts(t *testing.T) {
	db := testDB(t)
	c := New()
	r := NewFoodIndexRefresher(db, c, time.Minute, quietLogger())

	var want struct {
		Total    int64
		Embedded int64
	}
	if err := db.Raw(
		"SELECT count(*) AS total, count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded FROM food_items",
	).Scan(&want).Error; err != nil {
		t.Fatalf("baseline query: %v", err)
	}

	if err := r.RefreshOnce(context.Background()); err != nil {
		t.Fatalf("RefreshOnce: %v", err)
	}

	items, embedded, missing := c.FoodIndexGauges()
	if got := int64(testutil.ToFloat64(items)); got != want.Total {
		t.Errorf("items gauge = %d, want %d (the real food_items count)", got, want.Total)
	}
	if got := int64(testutil.ToFloat64(embedded)); got != want.Embedded {
		t.Errorf("embedded gauge = %d, want %d (the real embedded count)", got, want.Embedded)
	}
	if got := int64(testutil.ToFloat64(missing)); got != want.Total-want.Embedded {
		t.Errorf("missing gauge = %d, want %d", got, want.Total-want.Embedded)
	}
}

// The negative twin. Observability failing must never take the product down,
// and must never publish a LIE — a failed query leaves the last good reading
// standing rather than zeroing the gauges, which would look exactly like an
// empty food index and page someone at 3am for nothing.
func TestRefreshOnceLeavesGaugesOnQueryFailure(t *testing.T) {
	db := testDB(t)
	c := New()
	c.SetFoodIndex(7898, 3820)

	broken := db.Session(&gorm.Session{})
	if err := broken.Exec("SET search_path TO pg_temp").Error; err != nil {
		t.Fatalf("could not break the session: %v", err)
	}
	r := NewFoodIndexRefresher(broken, c, time.Minute, quietLogger())

	err := r.RefreshOnce(context.Background())
	if err == nil {
		t.Fatal("RefreshOnce returned nil error against a session that cannot see food_items")
	}

	items, embedded, missing := c.FoodIndexGauges()
	if got := testutil.ToFloat64(items); got != 7898 {
		t.Errorf("items gauge = %v after a failed refresh, want the last good value 7898", got)
	}
	if got := testutil.ToFloat64(embedded); got != 3820 {
		t.Errorf("embedded gauge = %v after a failed refresh, want the last good value 3820", got)
	}
	if got := testutil.ToFloat64(missing); got != 4078 {
		t.Errorf("missing gauge = %v after a failed refresh, want the last good value 4078", got)
	}
}

// Run must publish IMMEDIATELY rather than waiting out the first tick —
// otherwise a pod that restarts every few minutes never reports at all.
func TestRunRefreshesImmediatelyAndStopsOnContextCancel(t *testing.T) {
	db := testDB(t)
	c := New()
	r := NewFoodIndexRefresher(db, c, time.Hour, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.Run(ctx)
		close(done)
	}()

	deadline := time.After(5 * time.Second)
	items, _, _ := c.FoodIndexGauges()
	for testutil.ToFloat64(items) == 0 {
		select {
		case <-deadline:
			cancel()
			t.Fatal("Run did not publish within 5s despite a 1h interval — it is waiting for the first tick")
		case <-time.After(10 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancel")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/metrics/ -run 'Refresh|Run' -v`
Expected: FAIL to compile — `NewFoodIndexRefresher undefined`.

**If any test reports `--- SKIP`, stop.** The container `kora-pg-test` must be up (`docker ps | grep kora-pg-test`) and migrated. A skipped test proves nothing and must never be accepted as a pass.

- [ ] **Step 3: Write the implementation**

Create `api/internal/metrics/foodindex.go`:

```go
package metrics

import (
	"context"
	"log/slog"
	"time"

	"gorm.io/gorm"
)

// foodIndexQuery reads both counts in ONE pass. Two separate queries could
// straddle a concurrent embed and report an embedded count that exceeds the
// total, which is not a state the database is ever actually in.
const foodIndexQuery = `SELECT count(*) AS total,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM food_items`

// FoodIndexRefresher publishes food-index completeness gauges from the
// database on a timer. This answers a question about database STATE rather
// than about events this process observed, which is why it needs a poller at
// all — every other metric in this package is incremented at the seam where
// the thing happens.
type FoodIndexRefresher struct {
	db       *gorm.DB
	c        *Collectors
	interval time.Duration
	logger   *slog.Logger
}

// NewFoodIndexRefresher wires a refresher. It deliberately takes *Collectors
// rather than using the package default so tests get an isolated registry.
func NewFoodIndexRefresher(db *gorm.DB, c *Collectors, interval time.Duration, logger *slog.Logger) *FoodIndexRefresher {
	return &FoodIndexRefresher{db: db, c: c, interval: interval, logger: logger}
}

// RefreshOnce runs the query and publishes the gauges. On a query failure it
// returns the error WITHOUT touching the gauges: the last good reading stands.
// Zeroing them instead would be indistinguishable from a genuinely empty food
// index, which is a real and alarming state (#97) that must not be faked by an
// unrelated database blip.
func (r *FoodIndexRefresher) RefreshOnce(ctx context.Context) error {
	var row struct {
		Total    int64
		Embedded int64
	}
	if err := r.db.WithContext(ctx).Raw(foodIndexQuery).Scan(&row).Error; err != nil {
		return err
	}
	r.c.SetFoodIndex(row.Total, row.Embedded)
	return nil
}

// Run refreshes immediately, then on every tick, until ctx is done. It never
// returns an error and never panics the process: losing observability must not
// take down the product, the same rule cmd/api/main.go already applies to the
// metrics listener.
func (r *FoodIndexRefresher) Run(ctx context.Context) {
	r.refreshLogging(ctx)

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.refreshLogging(ctx)
		}
	}
}

func (r *FoodIndexRefresher) refreshLogging(ctx context.Context) {
	if err := r.RefreshOnce(ctx); err != nil {
		r.logger.Error("food index gauge refresh failed", "err", err)
	}
}
```

Then amend the package doc in `api/internal/metrics/metrics.go`. Replace lines 3-5:

```go
// It deliberately accepts only primitives, so it imports nothing from ai,
// billing or foodlog and can be tested entirely on its own. Every label passes
// through a closed allowlist (labels.go) before it reaches a collector.
```

with:

```go
// The recording seams accept only primitives, so this package imports nothing
// from ai, billing or foodlog and can be tested on its own. Every label passes
// through a closed allowlist (labels.go) before it reaches a collector.
//
// foodindex.go is the one exception and imports gorm: the food-index gauges
// describe database STATE rather than events this process observed, so they
// need a poller instead of a recording seam. It still imports no domain
// package — it holds its own SQL.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/metrics/ -v`
Expected: PASS. Confirm each new test line reads `--- PASS`, not `--- SKIP`.

- [ ] **Step 5: Mutation-verify**

One at a time, reverting between each:

1. In `RefreshOnce`, move `r.c.SetFoodIndex(row.Total, row.Embedded)` to *before* the error check and make the error branch `r.c.SetFoodIndex(0, 0); return err`.
   Expected: `TestRefreshOnceLeavesGaugesOnQueryFailure` fails on `items gauge = 0 after a failed refresh, want the last good value 7898`. Revert.
2. Delete the `r.c.SetFoodIndex(row.Total, row.Embedded)` line entirely (return `nil`).
   Expected: `TestRefreshOncePublishesTheQueriedCounts` fails on `items gauge = 0, want 7898`. This is the mutation the failure test alone would NOT catch. Revert.
3. In `Run`, delete the leading `r.refreshLogging(ctx)` so it waits for the first tick.
   Expected: `TestRunRefreshesImmediatelyAndStopsOnContextCancel` fails on `Run did not publish within 5s despite a 1h interval`. Revert.
4. Change `count(*) FILTER (WHERE embedding IS NOT NULL)` to `count(*)`.
   Expected: `TestRefreshOncePublishesTheQueriedCounts` fails on the `embedded gauge` assertion (7898 vs 3820). **If it passes, the test DB has a fully-embedded food_items table and this assertion is vacuous** — seed some unembedded rows or say so explicitly in the report. Revert.

Confirm `git diff` is clean.

- [ ] **Step 6: Commit**

```bash
git add api/internal/metrics/foodindex.go api/internal/metrics/foodindex_test.go api/internal/metrics/metrics.go
git commit -m "feat(api): refresh food index gauges from the database on a timer"
```

---

### Task 3: Wire the refresher into the API

**Files:**
- Modify: `api/internal/config/config.go` (add `FoodIndexRefreshInterval`)
- Modify: `api/internal/config/config_test.go`
- Modify: `api/cmd/api/main.go` (start the refresher, cancel it on shutdown)

**Interfaces:**
- Consumes: `metrics.NewFoodIndexRefresher`, `metrics.Default()` from Tasks 1-2.
- Produces: `config.Config.FoodIndexRefreshInterval time.Duration`, env `FOOD_INDEX_REFRESH_INTERVAL`, default `60s`, `0` disables.

- [ ] **Step 1: Write the failing tests**

Read `api/internal/config/config_test.go` first and match its existing idiom for duration env vars (`SchedulerInterval` / `PushInterval` are the models). Append the *pair* — a default test alone would pass against a hardcoded constant, which is exactly the flaw already noted for `TestLoadDefaultsMetricsPortTo9090`:

```go
func TestLoadDefaultsFoodIndexRefreshIntervalTo60s(t *testing.T) {
	t.Setenv("FOOD_INDEX_REFRESH_INTERVAL", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.FoodIndexRefreshInterval != 60*time.Second {
		t.Errorf("FoodIndexRefreshInterval = %v, want 60s", cfg.FoodIndexRefreshInterval)
	}
}

func TestLoadReadsFoodIndexRefreshIntervalFromEnv(t *testing.T) {
	t.Setenv("FOOD_INDEX_REFRESH_INTERVAL", "5m")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.FoodIndexRefreshInterval != 5*time.Minute {
		t.Errorf("FoodIndexRefreshInterval = %v, want 5m", cfg.FoodIndexRefreshInterval)
	}
}
```

If `Load()` in this package requires other env vars to be set, copy whatever setup the neighbouring duration tests already do — do not invent a new fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/config/ -run FoodIndex -v`
Expected: FAIL to compile — `cfg.FoodIndexRefreshInterval undefined`.

- [ ] **Step 3: Write the implementation**

In `api/internal/config/config.go`, add the field to `Config` next to the other durations:

```go
	// FoodIndexRefreshInterval is how often the food-index completeness gauges
	// are re-read from the database. The value only changes when the embed job
	// runs, so this is deliberately slow. 0 disables the refresher.
	FoodIndexRefreshInterval time.Duration
```

and populate it in `Load()` using the same duration-parsing helper the neighbouring `SchedulerInterval` / `PushInterval` fields use, with a `60 * time.Second` default.

In `api/cmd/api/main.go`, after the push-dispatcher block and before `srv := &http.Server{`:

```go
	fiCtx, fiCancel := context.WithCancel(context.Background())
	if cfg.FoodIndexRefreshInterval > 0 {
		refresher := metrics.NewFoodIndexRefresher(db, metrics.Default(), cfg.FoodIndexRefreshInterval, logger)
		go refresher.Run(fiCtx)
		logger.Info("food index gauge refresher started", "interval", cfg.FoodIndexRefreshInterval.String())
	}
```

and add `fiCancel()` alongside the existing `schedCancel()` / `pushCancel()` calls in the shutdown block.

- [ ] **Step 4: Run the full suite**

Run: `cd api && go vet ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...`
Expected: vet clean; every package `ok`, zero `FAIL`.

- [ ] **Step 5: Mutation-verify the config pair**

Change the default in `Load()` from `60 * time.Second` to `30 * time.Second`.
Expected: `TestLoadDefaultsFoodIndexRefreshIntervalTo60s` fails on `FoodIndexRefreshInterval = 30s, want 60s`; the env-override test still passes. Then hardcode the field to `60 * time.Second` ignoring the env var.
Expected: `TestLoadReadsFoodIndexRefreshIntervalFromEnv` fails on `= 1m0s, want 5m`. Revert both, confirm `git diff` clean.

- [ ] **Step 6: Commit and open the PR**

```bash
git add api/internal/config/config.go api/internal/config/config_test.go api/cmd/api/main.go
git commit -m "feat(api): start the food index gauge refresher"
git push -u origin feat/food-index-gauges
gh pr create --title "feat(api): food index completeness gauges (#43)" --body "<summary>"
```

Wait for CI to be green (`api`, `mobile`, `build-image` is skipped on PRs and runs on merge). Then **ask Mahesh to merge** — `gh pr merge` is often denied by the permission classifier.

---

### Task 4: Deploy and verify the gauges in prod

No manual `docker buildx`. CI already built the image on merge.

- [ ] **Step 1: Confirm CI built the image for the merge commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git fetch origin && git log --oneline -1 origin/main
gh run list --branch main --limit 3
gh run view <run-id> --json jobs -q '.jobs[] | "\(.name) \(.conclusion)"'
```
Expected: `build-image success`. Record the merge SHA — call it `$SHA`.

- [ ] **Step 2: Point the ArgoCD Application at the new image**

```bash
kubectl -n argocd patch application kora-api --type=merge \
  -p "{\"spec\":{\"source\":{\"helm\":{\"parameters\":[{\"name\":\"image.tag\",\"value\":\"$SHA\"}]}}}}"
kubectl -n argocd annotate application kora-api argocd.argoproj.io/refresh=hard --overwrite
```

This is durable: `kora-app-of-apps` sets `ignoreDifferences` on `/spec/source/helm/parameters` on purpose.

- [ ] **Step 3: Verify the RUNNING DIGEST, not the rollout status**

"successfully rolled out" and ArgoCD "Synced/Healthy" are both independently worthless as evidence — each has lied in this project.

```bash
kubectl -n kora rollout status deploy/kora-api --timeout=300s
kubectl -n kora get pods -l app=kora-api \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].imageID}{"\n"}{end}'
```
Expected: a Ready pod whose `imageID` digest matches the digest CI printed for `$SHA`. If it matches the *previous* digest, the GAR pull-through mirror served a stale image — the tag is a commit SHA so this should not happen, but check rather than assume.

- [ ] **Step 4: Verify the gauges are actually served**

```bash
kubectl -n kora exec deploy/kora-api -- wget -qO- http://localhost:9090/metrics | grep kora_food_index
```
Expected three `kora_food_index_*` lines. Cross-check them against the database directly — the gauge is only useful if it agrees with truth:

```bash
kubectl exec -n global global-postgres-1 -c postgres -- psql -U postgres -d kora_db -t \
  -c "SELECT count(*), count(*) FILTER (WHERE embedding IS NOT NULL) FROM food_items;"
```
Expected: `kora_food_index_items` equals the first number, `kora_food_index_embedded` the second, `kora_food_index_missing` their difference. As of 2026-08-05 that is **7898 / 3820 / 4078**.

Note: the app still reads `kora_db` on the shared `global-postgres`; the Kora Postgres cutover is staged but has not run (`docs/runbooks/kora-postgres-cutover.md`). Query the cluster the app is actually pointed at.

- [ ] **Step 5: Verify GMP ingested them**

Give the scrape a couple of minutes, then:

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
 "https://monitoring.googleapis.com/v3/projects/tesseracthub-480811/metricDescriptors?filter=metric.type%3Dstarts_with(%22prometheus.googleapis.com%2Fkora_%22)&pageSize=20" \
 | python3 -c "import sys,json;[print(m['type']) for m in json.load(sys.stdin).get('metricDescriptors',[])]"
```
Expected: `kora_food_index_items/gauge`, `kora_food_index_embedded/gauge`, `kora_food_index_missing/gauge`, plus the counters and histogram from #93. Before this deploy the same query returned **zero** descriptors, so a non-empty result is real evidence.

- [ ] **Step 6: Record the outcome in the ledger**

Append to `.superpowers/sdd/progress.md`: the merge SHA, the running digest, the three observed gauge values, and whether they matched the database.

---

# Part B — a Prometheus endpoint the portal can actually reach

Repo: `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s`. Branch: `feat/gmp-frontend`.

Without this, every Kora panel from Part C renders `—` — as do Resources and Database for mark8ly, homechef and devai today.

### Task 5: Deploy the GMP frontend proxy

The GMP `frontend` speaks the Prometheus HTTP API (`/api/v1/query`, `/api/v1/query_range`) over Cloud Monitoring, which is exactly what `apps/web/lib/metrics/prometheus.ts` calls. It needs a GCP service account with `roles/monitoring.viewer` bound to its KSA via Workload Identity — no such GSA exists yet.

**Files:**
- Create: `charts/apps/gmp-frontend/Chart.yaml`
- Create: `charts/apps/gmp-frontend/values.yaml`
- Create: `charts/apps/gmp-frontend/templates/serviceaccount.yaml`
- Create: `charts/apps/gmp-frontend/templates/deployment.yaml`
- Create: `charts/apps/gmp-frontend/templates/service.yaml`
- Create: `argocd/prod/apps/global/gmp-frontend.yaml`
- Modify: `argocd/prod/apps/global/kustomization.yaml` (add the new file to `resources:` — the directory is a kustomization, so an Application file that isn't listed there is simply never applied)

**Placement:** there is no `monitoring` app-of-apps. Shared, cross-product infrastructure lives in `argocd/prod/apps/global/` (alongside `company.yaml`, `tesserix-postgres.yaml`, `global-postgres.yaml`), managed by `global-app-of-apps` (`project: platform`, `selfHeal: true`). The workload still deploys into the `monitoring` namespace; only the Application manifest lives under `global`.

**Interfaces:**
- Produces: a Service reachable in-cluster at `http://gmp-frontend.monitoring.svc.cluster.local:9090`, serving the Prometheus HTTP API over GMP.

- [ ] **Step 1: Create the GCP service account and IAM bindings**

```bash
gcloud iam service-accounts create gmp-frontend \
  --project=tesseracthub-480811 \
  --display-name="GMP frontend — read-only Cloud Monitoring for the admin portal"

gcloud projects add-iam-policy-binding tesseracthub-480811 \
  --member="serviceAccount:gmp-frontend@tesseracthub-480811.iam.gserviceaccount.com" \
  --role="roles/monitoring.viewer"

gcloud iam service-accounts add-iam-policy-binding \
  gmp-frontend@tesseracthub-480811.iam.gserviceaccount.com \
  --project=tesseracthub-480811 \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:tesseracthub-480811.svc.id.goog[monitoring/gmp-frontend]"
```

**If the permission classifier denies any of these, do not work around it.** Hand the three commands to Mahesh to run with a leading `!`.

Verify before moving on:
```bash
gcloud projects get-iam-policy tesseracthub-480811 \
  --flatten="bindings[].members" --format="value(bindings.role,bindings.members)" \
  | grep gmp-frontend
```
Expected: a `roles/monitoring.viewer` line.

- [ ] **Step 2: Write the chart**

`charts/apps/gmp-frontend/Chart.yaml`:

```yaml
apiVersion: v2
name: gmp-frontend
description: Google Managed Prometheus frontend — serves the Prometheus HTTP API over Cloud Monitoring so in-cluster consumers (the tesserix-home admin portal) can run PromQL against GMP.
type: application
version: 0.1.0
appVersion: "0.15.3"
```

`charts/apps/gmp-frontend/values.yaml`:

```yaml
# The admin portal reads PROMETHEUS_URL and speaks plain Prometheus HTTP API.
# GMP has no such endpoint of its own — this proxy is the supported way to get
# one. Before it existed, PROMETHEUS_URL pointed at prometheus-server.monitoring,
# a Service scaled to zero with no endpoints, so every metrics panel in the
# portal rendered "—" for every product.
image:
  repository: gke.gcr.io/prometheus-engine/frontend
  tag: v0.15.3-gke.0
  pullPolicy: IfNotPresent

projectID: tesseracthub-480811

serviceAccount:
  name: gmp-frontend
  annotations:
    iam.gke.io/gcp-service-account: "gmp-frontend@tesseracthub-480811.iam.gserviceaccount.com"

service:
  port: 9090

resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 250m
    memory: 512Mi
```

Confirm the image tag is real before applying — `gcloud container images list-tags gke.gcr.io/prometheus-engine/frontend --limit=10` — and pin to whatever current version that returns rather than trusting the value written here.

`templates/serviceaccount.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Values.serviceAccount.name }}
  namespace: {{ .Release.Namespace }}
  annotations:
    {{- toYaml .Values.serviceAccount.annotations | nindent 4 }}
```

`templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gmp-frontend
  namespace: {{ .Release.Namespace }}
  labels:
    app: gmp-frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gmp-frontend
  template:
    metadata:
      labels:
        app: gmp-frontend
    spec:
      serviceAccountName: {{ .Values.serviceAccount.name }}
      automountServiceAccountToken: true
      containers:
        - name: frontend
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args:
            - "--web.listen-address=:9090"
            - "--query.project-id={{ .Values.projectID }}"
          ports:
            - name: web
              containerPort: 9090
          readinessProbe:
            httpGet:
              path: /-/ready
              port: web
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: web
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

`templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: gmp-frontend
  namespace: {{ .Release.Namespace }}
  labels:
    app: gmp-frontend
spec:
  selector:
    app: gmp-frontend
  ports:
    - name: web
      port: {{ .Values.service.port }}
      targetPort: web
```

- [ ] **Step 3: Validate before applying**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
helm template gmp-frontend charts/apps/gmp-frontend --namespace monitoring
helm template gmp-frontend charts/apps/gmp-frontend --namespace monitoring | kubectl apply --dry-run=server -f -
```
Expected: three resources, each `(server dry run)`. Note tesserix-k8s CI cannot run (dead since 2026-08-03) and `.github/workflows/pr-validation.yaml` does not cover `manifests/**` anyway — this dry run is the only real validation the change will get, so do not skip it.

After Step 4 adds the Application, also prove the kustomization actually picks it up:

```bash
kubectl kustomize argocd/prod/apps/global | grep -c "name: gmp-frontend"
```
Expected: `1`. A `0` means the file was created but never listed in `resources:`, which fails silently.

- [ ] **Step 4: Write the ArgoCD Application and merge**

Create `argocd/prod/apps/global/gmp-frontend.yaml`, modelled on the sibling `argocd/prod/apps/global/company.yaml` — read it first and match its `project` (`platform`), label block and `syncPolicy` exactly:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gmp-frontend
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: tesseract-platform
    app.kubernetes.io/component: observability
    environment: prod
spec:
  project: platform
  source:
    repoURL: https://github.com/tesserix/tesserix-k8s.git
    targetRevision: HEAD
    path: charts/apps/gmp-frontend
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
```

Then register it in `argocd/prod/apps/global/kustomization.yaml`, matching that file's comment style:

```yaml
  # GMP frontend — serves the Prometheus HTTP API over Managed Prometheus so
  # the admin portal's PROMETHEUS_URL has a live endpoint to talk to.
  - gmp-frontend.yaml
```

**If this file is not added to `kustomization.yaml` the Application is never created and nothing else in Part B will work** — and ArgoCD will report the app-of-apps perfectly Synced while it does so.

```bash
git checkout -b feat/gmp-frontend
git add charts/apps/gmp-frontend argocd/prod/apps/global/gmp-frontend.yaml argocd/prod/apps/global/kustomization.yaml
git commit -m "feat(monitoring): gmp frontend so in-cluster consumers can run promql against managed prometheus"
git push -u origin feat/gmp-frontend
gh pr create --title "feat(monitoring): GMP frontend proxy" --body "<summary>"
```

CI will fail in ~2s with no runner assigned. That is the repo-wide outage, not this change — say so in the PR body. Ask Mahesh to merge.

- [ ] **Step 5: Verify it actually answers PromQL**

Do not trust ArgoCD's status. Compare the revision to git HEAD and force a refresh if they differ:

```bash
kubectl -n argocd get application gmp-frontend -o jsonpath='{.status.sync.revision}{"\n"}'
git -C /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s rev-parse origin/main
# if they differ:
kubectl -n argocd annotate application gmp-frontend argocd.argoproj.io/refresh=hard --overwrite
```

Then query it end to end from inside the cluster:

```bash
kubectl -n monitoring port-forward svc/gmp-frontend 9091:9090 &
curl -s 'http://localhost:9091/api/v1/query?query=up' | head -c 400
curl -s --get 'http://localhost:9091/api/v1/query' \
  --data-urlencode 'query=kora_food_index_items' | python3 -m json.tool
```
Expected: `"status":"success"`, and the `kora_food_index_items` query returns a single sample equal to the number Task 4 Step 4 observed. **If it returns an empty result set, Part C's panels will be empty — stop and diagnose here, not in the portal.**

Kill the port-forward when done.

---

### Task 6: Repoint the portal at the working endpoint

**Files:**
- Modify: `charts/apps/company/values.yaml:202`

- [ ] **Step 1: Change the value**

```yaml
  # Was http://prometheus-server.monitoring — that Service has had ZERO
  # endpoints since the self-hosted stack was scaled to replicas=0, so every
  # Resources/Database panel in the portal rendered "—" for every product.
  # GMP is where metrics actually land (PodMonitoring CRs), and gmp-frontend
  # serves the Prometheus HTTP API over it.
  PROMETHEUS_URL: "http://gmp-frontend.monitoring.svc.cluster.local:9090"
```

- [ ] **Step 2: Validate, commit, merge**

```bash
helm template company charts/apps/company --namespace tesserix | grep -A2 PROMETHEUS_URL
git add charts/apps/company/values.yaml
git commit -m "fix(company): point the admin portal at gmp-frontend instead of the scaled-down prometheus"
```
Push, PR, ask Mahesh to merge (CI will fail for the repo-wide reason).

- [ ] **Step 3: Verify the portal's own view changed**

```bash
kubectl -n tesserix get deploy company -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | grep PROMETHEUS
kubectl -n tesserix rollout status deploy/company --timeout=300s
```
Expected: the new URL, on a Ready pod.

- [ ] **Step 4: Verify a panel that was previously dead**

Open `/admin/apps/mark8ly` in the portal and check the **Resources** section. Before this change cpu/memory read `—`; they should now carry numbers. This is a pre-existing product, so it isolates the metrics-plane fix from anything Kora-specific — if Resources is still `—`, the problem is Part B, not Part C.

Note `cnpg_*` metrics have **zero descriptors in GMP** — they were scraped by the self-hosted Prometheus. The Database panel may therefore stay `—` even after this task. That is a known, separate gap: it needs GMP `PodMonitoring` resources for the CNPG clusters. Do not treat it as a failure of this task, and report it rather than silently absorbing it.

---

# Part C — tesserix-home portal integration

Repo: `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home`. Branch: `feat/kora-admin-overview`.

### Task 7: The ProductConfig entry

**Files:**
- Modify: `apps/web/lib/products/configs.ts`
- Test: `apps/web/lib/products/__tests__/configs.test.ts` (create if the directory convention differs — check where existing vitest specs live with `find apps/web -name '*.test.ts*' | head` and follow it)

**Interfaces:**
- Produces: `getProductConfig("kora")` returns a `ProductConfig` with `id: "kora"`, `namespace: "kora"`, `cnpgClusterName: "kora-postgres"`, and four `businessKpiTiles` keyed `food_index_missing`, `ai_calls_24h`, `ai_failures_24h`, `decompose_over_budget_pct`. Task 8's KPI route must return exactly these four keys. **Task 11 later appends two more** (`ai_keys_configured`, `ai_key_age_days`) and updates this task's test accordingly — four is correct as of this task, not a final count.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { getProductConfig, listProductConfigs } from "@/lib/products/configs";

describe("kora product config", () => {
  it("is registered and resolvable by id", () => {
    const kora = getProductConfig("kora");
    expect(kora.id).toBe("kora");
    expect(kora.name).toBe("Kora");
    expect(kora.namespace).toBe("kora");
  });

  // Kora got a DEDICATED CloudNativePG cluster on 2026-08-04. Pointing this at
  // the shared global-postgres would silently report four other products'
  // database figures labelled as Kora's — a wrong number, not a missing one.
  it("points the DB panels at the dedicated cluster, not the shared one", () => {
    expect(getProductConfig("kora").cnpgClusterName).toBe("kora-postgres");
    expect(getProductConfig("kora").cnpgClusterName).not.toBe("global-postgres");
  });

  // Kora has no subscriptions, so the billing section must auto-hide.
  // hasBilling in product-overview-layout.tsx is Boolean(config.pricingByPlan).
  it("declares no pricing, so the billing section hides", () => {
    expect(getProductConfig("kora").pricingByPlan).toBeUndefined();
  });

  // These four keys are the contract with /api/admin/apps/kora/kpis.
  // resolveKpiValue looks each tile up BY KEY in the KPI map; a key that
  // disagrees renders "—" with no error anywhere.
  it("declares the four tiles the kpis route populates", () => {
    const keys = getProductConfig("kora").businessKpiTiles.map((t) => t.key);
    expect(keys).toEqual([
      "food_index_missing",
      "ai_calls_24h",
      "ai_failures_24h",
      "decompose_over_budget_pct",
    ]);
    for (const tile of getProductConfig("kora").businessKpiTiles) {
      expect(tile.source).toBe("product");
    }
  });

  it("appears in the registry listing", () => {
    expect(listProductConfigs().map((c) => c.id)).toContain("kora");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/products`
Expected: FAIL — `Unknown product: kora`.

- [ ] **Step 3: Implement**

In `apps/web/lib/products/configs.ts`, after the `devai` const:

```ts
// Kora — AI food logging (Expo mobile app + a single Go API, kora-api). One
// namespace `kora`, dedicated CNPG cluster `kora-postgres` (provisioned
// 2026-08-04; it was on the shared global-postgres before that). No
// subscriptions, so pricing is omitted and the billing section hides.
//
// Its overview KPIs are OPERATING signals rather than business ones: this
// surface exists to catch things like the food index sitting at 42% embedded
// for the life of the project, invisible because cmd/embed exits 0 when it
// gives up and the Kubernetes Job therefore reports Complete (#97). All four
// are PromQL over the kora-api exporter, served by
// /api/admin/apps/kora/kpis. There is deliberately no per-user metric —
// Prometheus carries no user_id label (unbounded cardinality on a Managed
// Prometheus bill); ai_usage_events stays authoritative for that, see
// kora/docs/ai-usage-queries.md.
const kora: ProductConfig = {
  id: "kora",
  name: "Kora",
  namespace: "kora",
  cnpgClusterName: "kora-postgres",
  sendGridProductTag: "kora",
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "food_index_missing", label: "Food index gaps", hint: "rows with no embedding — should be 0", source: "product" },
    { key: "ai_calls_24h", label: "AI calls (24h)", hint: "successful provider calls", source: "product" },
    { key: "ai_failures_24h", label: "AI failures (24h)", hint: "errors + timeouts", source: "product" },
    { key: "decompose_over_budget_pct", label: "Decompose over budget", hint: "% past the 1.5s textBudget", source: "product" },
  ],
};
```

and add `kora,` to `REGISTRY`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run lib/products && npm run typecheck`
Expected: PASS, `tsc` exit 0.

- [ ] **Step 5: Mutation-verify**

Change `cnpgClusterName` to `"global-postgres"`.
Expected: the dedicated-cluster test fails on its own assertion. Revert. Then remove one tile from `businessKpiTiles`.
Expected: the four-tiles test fails on the array comparison. Revert, confirm `git diff` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/products/configs.ts apps/web/lib/products/__tests__/configs.test.ts
git commit -m "feat(admin): kora product config"
```

---

### Task 8: The KPI route

**Files:**
- Modify: `apps/web/app/api/admin/apps/[product]/kpis/route.ts`
- Test: `apps/web/app/api/admin/apps/[product]/kpis/__tests__/kora-kpis.test.ts` (follow the repo's existing route-test convention if one exists; otherwise create it here)

**Interfaces:**
- Consumes: `queryInstant(promql: string, atSeconds?: number): Promise<ReadonlyArray<PromInstantResult>>` from `@/lib/metrics/prometheus`; `PromInstantResult.value.value` is the sample as a `number`.
- Produces: `GET /api/admin/apps/kora/kpis` → `{ food_index_missing, ai_calls_24h, ai_failures_24h, decompose_over_budget_pct }`, all numbers.

- [ ] **Step 1: Write the failing tests**

Each lookup must degrade **independently** — this is the pattern the devai branch already follows, and the reason is that one dead upstream must blank one tile, not the whole set.

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const queryInstant = vi.fn();
vi.mock("@/lib/metrics/prometheus", () => ({ queryInstant: (q: string) => queryInstant(q) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { GET } from "../route";

function sample(v: number) {
  return [{ metric: {}, value: { time: Date.now(), value: v } }];
}

function req(product: string) {
  return GET(new Request(`http://x/api/admin/apps/${product}/kpis`), {
    params: Promise.resolve({ product }),
  });
}

beforeEach(() => queryInstant.mockReset());

describe("kora kpis", () => {
  it("returns all four tile keys from prometheus", async () => {
    queryInstant.mockImplementation((q: string) => {
      if (q.includes("kora_food_index_missing")) return Promise.resolve(sample(4078));
      if (q.includes("kora_ai_calls_total") && q.includes('outcome="ok"')) return Promise.resolve(sample(122));
      if (q.includes("kora_ai_calls_total")) return Promise.resolve(sample(3));
      if (q.includes("kora_ai_latency_seconds")) return Promise.resolve(sample(4.5));
      throw new Error(`unexpected query: ${q}`);
    });

    const body = await (await req("kora")).json();
    expect(body.food_index_missing).toBe(4078);
    expect(body.ai_calls_24h).toBe(122);
    expect(body.ai_failures_24h).toBe(3);
    expect(body.decompose_over_budget_pct).toBe(4.5);
  });

  // The "must not" — one dead query must not blank the others...
  it("degrades one failing query without losing the rest", async () => {
    queryInstant.mockImplementation((q: string) => {
      if (q.includes("kora_food_index_missing")) return Promise.reject(new Error("prometheus_unavailable: 503"));
      return Promise.resolve(sample(7));
    });

    const res = await req("kora");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.food_index_missing).toBe(0);
    expect(body.ai_calls_24h).toBe(7);
    expect(body.ai_failures_24h).toBe(7);
    expect(body.decompose_over_budget_pct).toBe(7);
  });

  // ...and its twin: an EMPTY result set (the metric exists in no series yet)
  // must read as 0 rather than NaN or undefined, both of which render as a
  // broken tile rather than an honest zero.
  it("reads an empty prometheus result as 0", async () => {
    queryInstant.mockResolvedValue([]);
    const body = await (await req("kora")).json();
    for (const k of ["food_index_missing", "ai_calls_24h", "ai_failures_24h", "decompose_over_budget_pct"]) {
      expect(body[k]).toBe(0);
    }
  });

  it("does not query prometheus for other products", async () => {
    const body = await (await req("fanzone")).json();
    expect(queryInstant).not.toHaveBeenCalled();
    expect(body).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/api/admin/apps`
Expected: FAIL — the kora branch does not exist, so `req("kora")` falls through to `{}`.

- [ ] **Step 3: Implement**

Add to `apps/web/app/api/admin/apps/[product]/kpis/route.ts`, immediately after the `devai` block and before `if (product !== "homechef")`. Add `import { queryInstant } from "@/lib/metrics/prometheus";` at the top.

```ts
  // Kora's overview KPIs are OPERATING signals, all PromQL over the kora-api
  // exporter (#43). Each query degrades to 0 independently so one dead series
  // blanks one tile rather than the whole set — same rule as devai above.
  //
  // The 1.5 in the budget query is ai.textBudget, and it is a HISTOGRAM BUCKET
  // BOUNDARY on purpose (metrics.go latencyBuckets). Do not "tidy" it: if the
  // exporter's buckets are ever changed to the library defaults this query
  // silently starts interpolating instead of reading an exact bucket.
  if (product === "kora") {
    const queries: Record<string, string> = {
      food_index_missing: "kora_food_index_missing",
      ai_calls_24h: 'sum(increase(kora_ai_calls_total{outcome="ok"}[24h]))',
      ai_failures_24h: 'sum(increase(kora_ai_calls_total{outcome=~"error|timeout"}[24h]))',
      decompose_over_budget_pct:
        '100 * (1 - (' +
        'sum(rate(kora_ai_latency_seconds_bucket{call_type="decompose",le="1.5"}[24h])) / ' +
        'sum(rate(kora_ai_latency_seconds_count{call_type="decompose"}[24h]))))',
    };

    const out: Record<string, number> = {};
    await Promise.all(
      Object.entries(queries).map(async ([key, promql]) => {
        try {
          const rows = await queryInstant(promql);
          const v = rows[0]?.value.value;
          out[key] = typeof v === "number" && Number.isFinite(v) ? v : 0;
        } catch (err) {
          logger.warn(`[kora-kpis] ${key}: ${err instanceof Error ? err.message : "failed"}`);
          out[key] = 0;
        }
      }),
    );
    return NextResponse.json(out);
  }
```

`Number.isFinite` matters: when `decompose` has had no calls in the window the ratio is `0/0` and Prometheus returns `NaN`, which would otherwise reach the tile.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run app/api/admin/apps && npm run typecheck`
Expected: PASS, `tsc` exit 0.

- [ ] **Step 5: Mutation-verify**

1. Replace the `try/catch` body with a bare `out[key] = (await queryInstant(promql))[0]?.value.value ?? 0` (no catch).
   Expected: the degradation test fails — the rejected promise propagates and the response is no longer 200. Revert.
2. Drop the `Number.isFinite` guard, leaving `?? 0`, and change the empty-result test's mock to resolve `sample(NaN)` temporarily to confirm it would leak.
   Expected: a `NaN` reaches the body. Revert both the guard removal and the temporary mock change.
3. Change `outcome=~"error|timeout"` to `outcome="error"`.
   Expected: nothing fails, because the mock keys on `kora_ai_calls_total` generally — **note this in the report as a limitation of the test**, or tighten the mock to key on the exact query string. Prefer tightening.

Confirm `git diff` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/admin/apps/\[product\]/kpis/route.ts apps/web/app/api/admin/apps/\[product\]/kpis/__tests__/kora-kpis.test.ts
git commit -m "feat(admin): kora overview kpis from prometheus"
```

---

### Task 9: Page, nav, rail and mobile switcher

The portal's own comment (`lib/products/types.ts:2-3`) says adding a product is "a config-only change". **It is not** — the sidebar, the left icon rail and the mobile switcher are each hand-written per product. Note DevAI has nav but no rail icon; that is an existing inconsistency, not a pattern to copy.

**Files:**
- Create: `apps/web/app/admin/apps/kora/page.tsx`
- Create: `apps/web/public/kora-icon.png` (copied from the kora repo)
- Modify: `apps/web/components/admin/sidebar.tsx` — `koraNav` array (after `devaiNav`, ~line 202), `RailContext` union (:203), `getActiveContext` (:205-211), `getSecondaryNav` (:212-224), the `LeftRail` context icons (after the homechef `Tooltip` block, ~:445), and the mobile switcher (~:604)

- [ ] **Step 1: Copy the rail asset**

```bash
cp /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile/assets/brand/kora-rail-64.png \
   /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/apps/web/public/kora-icon.png
file apps/web/public/kora-icon.png
```
Expected: `PNG image data, 64 x 64`. Copy it in deliberately rather than referencing across repos. The rail renders it with `brightness-0 invert`, so it will show as a silhouette — check it reads at 24×24 in step 5.

- [ ] **Step 2: Write the page**

`apps/web/app/admin/apps/kora/page.tsx` — model it exactly on `apps/web/app/admin/apps/devai/page.tsx`. **Read that file first and match it**, including whether it is a server or client component and any metadata export:

```tsx
import { ProductOverviewLayout } from "@/components/admin/product-overview-layout";
import { getProductConfig } from "@/lib/products/configs";

export default function KoraOverviewPage() {
  return <ProductOverviewLayout config={getProductConfig("kora")} />;
}
```

- [ ] **Step 3: Wire the sidebar**

Add after `devaiNav`:

```tsx
// Kora secondary nav. Phase 1 is the Overview only — logs (Phase 2), user
// management (Phase 3) and economics (Phase 4) are scoped but not designed,
// and each needs its own brainstorm. Service health is namespace-keyed and
// already works for kora.
const koraNav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/kora", icon: LayoutDashboard },
  { name: "Service health", href: "/admin/health", icon: HeartPulse },
];
```

Extend the union:

```tsx
type RailContext = "platform" | "mark8ly" | "homechef" | "devai" | "kora";
```

Add to `getActiveContext`, before the `return "platform"`:

```tsx
  if (pathname.startsWith("/admin/apps/kora")) return "kora";
```

Add to `getSecondaryNav`'s switch, before `case "platform"`:

```tsx
    case "kora":
      return { label: "Kora", entries: koraNav };
```

In `LeftRail`, after the homechef `Tooltip` block, add the Kora one — copy the homechef block verbatim and change the four product-specific values (`href`, `onContextChange`, `activeContext ===`, `src`/`alt`, tooltip text):

```tsx
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/admin/apps/kora"
              onClick={() => onContextChange("kora")}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                activeContext === "kora"
                  ? "bg-sidebar-accent"
                  : "hover:bg-sidebar-accent/50"
              )}
            >
              <Image
                src="/kora-icon.png"
                alt="Kora"
                width={24}
                height={24}
                className="rounded-sm brightness-0 invert"
              />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Kora
          </TooltipContent>
        </Tooltip>
```

Then add the matching entry to the mobile switcher around line 604 — **read the surrounding block first** and copy the mark8ly/homechef entry's exact shape including `aria-selected` and `aria-current`, changing only the product values.

- [ ] **Step 4: Verify it compiles and the suite is green**

Run: `cd apps/web && npm run typecheck && npm run lint && npx vitest run`
Expected: `tsc` exit 0, lint 0 warnings (the script uses `--max-warnings 0`), all vitest suites pass.

- [ ] **Step 5: See it on a screen**

Run `npm run dev` (port 3002) and check, with a signed-in admin session:
1. `/admin/apps/kora` renders the Overview with a "Kora" header and four KPI tiles.
2. The left rail shows a Kora icon that is legible at 24×24 as a white silhouette, and it highlights when active.
3. The secondary nav reads "Kora" with the two entries, and Overview is marked active.
4. At a narrow viewport the mobile switcher includes Kora and selects it.
5. The billing/Revenue section is **absent** (no `pricingByPlan`).

Capture a screenshot for the report. Automated tests do not cover the rail or the mobile switcher, so this step is the only evidence for them.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/admin/apps/kora/page.tsx apps/web/public/kora-icon.png apps/web/components/admin/sidebar.tsx
git commit -m "feat(admin): kora overview page, nav, rail and mobile switcher"
```

---

### Task 10: The apps-registry migration

**Files:**
- Create: `apps/web/db/migrations/0015_seed_kora_app.sql`
- Modify: `apps/web/db/seeds/apps.sql`

The migration is what actually lands the row — `db/seeds/apps.sql` is **not auto-applied**, and a re-seed once silently dropped HomeChef's tile. But `0013_seed_devai_app.sql`'s own comment says to keep the two in sync, so update both: the migration is the mechanism, the seed file is the mirror.

- [ ] **Step 1: Write the migration**

`apps/web/db/migrations/0015_seed_kora_app.sql`, modelled on `0013_seed_devai_app.sql`:

```sql
-- 0015 — Add Kora to the apps registry (tesserix_admin.apps), same auto-applied,
-- idempotent pattern as 0013. Kora is the AI food-logging product: an Expo
-- mobile app plus a single Go API (kora-api) in namespace `kora`, backed by its
-- own CloudNativePG cluster `kora-postgres` (provisioned 2026-08-04 — it ran on
-- the shared global-postgres before that).
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps the row in sync with the values
-- checked in here. Mirror any change in db/seeds/apps.sql and this migration
-- together.
--
-- db_admin_secret_name is left NULL deliberately: Phase 1 is READ-ONLY and gets
-- everything from Prometheus, so no cross-DB admin role has been provisioned.
-- The directory tile renders without it. Phase 3 (user management) is where that
-- decision gets made — and the design there splits reads from writes, so it may
-- never need one.

INSERT INTO apps (
  slug, name, description, status,
  db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
  primary_domain, admin_url
) VALUES
(
  'kora',
  'Kora',
  'AI food logging — photo, voice and text meal capture with a nutrition index and coaching.',
  'active',
  'kora',
  'kora-postgres-rw.kora.svc.cluster.local',
  5432,
  NULL,
  '["kora_db"]'::jsonb,
  'kora-api.tesserix.app',
  'https://kora-api.tesserix.app'
)
ON CONFLICT (slug) DO UPDATE SET
  name                  = EXCLUDED.name,
  description           = EXCLUDED.description,
  status                = EXCLUDED.status,
  db_namespace          = EXCLUDED.db_namespace,
  db_host               = EXCLUDED.db_host,
  db_port               = EXCLUDED.db_port,
  db_admin_secret_name  = EXCLUDED.db_admin_secret_name,
  db_databases          = EXCLUDED.db_databases,
  primary_domain        = EXCLUDED.primary_domain,
  admin_url             = EXCLUDED.admin_url;
```

Before committing, confirm `apps.db_admin_secret_name` is actually nullable:
```bash
grep -n "db_admin_secret_name" apps/web/db/migrations/0001_init.sql apps/web/db/migrations/0012_seed_apps_registry.sql
```
If it is `NOT NULL`, use the devai-style placeholder value instead and note the change.

Also confirm the `kora-postgres-rw` Service name is real:
```bash
kubectl -n kora get svc | grep kora-postgres
```

- [ ] **Step 2: Mirror it into the seed file**

Append the same `INSERT ... ON CONFLICT` block to `apps/web/db/seeds/apps.sql`, following the formatting and comment style of the `homechef` entry already in that file.

- [ ] **Step 3: Apply it locally and verify the row**

```bash
cd apps/web && node --env-file=../../.env.local scripts/db-migrate.mjs
```
(Adjust the env-file path to wherever this repo's local env actually lives — check the repo root and `apps/web/`.)

Then verify the row exists and that re-running is genuinely idempotent:

```bash
node --env-file=../../.env.local scripts/db-migrate.mjs   # second run: should be a no-op
```
and query the table for `slug = 'kora'`, confirming exactly one row.

- [ ] **Step 4: Verify the tile renders**

Reload `/admin/apps` in the dev server. Expected: a Kora tile alongside Mark8ly, Fe3dr and DevAI, linking to `/admin/apps/kora`.

- [ ] **Step 5: Commit and open the PR**

```bash
git add apps/web/db/migrations/0015_seed_kora_app.sql apps/web/db/seeds/apps.sql
git commit -m "feat(admin): register kora in the apps registry"
git push -u origin feat/kora-admin-overview
gh pr create --title "feat(admin): Kora overview surface" --body "<summary>"
```

Ask Mahesh to merge, then confirm the migration ran against the real `tesserix` database after deploy — the row is what drives the `/admin/apps` grid, and a migration that failed leaves the tile missing with no other symptom.

---

### Task 11: AI key health (read-only)

Kora's AI keys live in GCP Secret Manager as `prod-kora-gemini-api-key` and `prod-kora-openai-api-key`, reach the cluster through the `kora-api-secrets` ExternalSecret (`refreshInterval: 1h`), and land as pod **env vars**. This task adds two read-only tiles answering "are both keys present, and when were they last rotated?" — the realistic silent failure, since a key that expires takes every AI path down at once.

**Metadata only.** This code calls `listSecretVersions` / `getSecret` and **never** `accessSecretVersion`. No secret value is ever read into the portal process. That boundary is enforced by a test, not just by intent.

**No new IAM is required** — verified 2026-08-05: the portal's KSA `company` (ns `tesserix`) is bound to GSA `app-secrets-marketplace-prod@tesseracthub-480811.iam.gserviceaccount.com`, which already holds project-level `roles/secretmanager.admin` **and** `roles/secretmanager.secretAccessor`. Note that this is far broader than this feature needs and is worth raising separately (see "Findings to report" below); do not widen it further, and do not narrow it as part of this task either — other things may depend on it.

**Files:**
- Modify: `apps/web/package.json` (add `@google-cloud/secret-manager`)
- Create: `apps/web/lib/secrets/key-health.ts`
- Create: `apps/web/lib/secrets/__tests__/key-health.test.ts`
- Modify: `apps/web/app/api/admin/apps/[product]/kpis/route.ts` (extend the `kora` branch)
- Modify: `apps/web/lib/products/configs.ts` (two more tiles)
- Modify: `apps/web/lib/products/__tests__/configs.test.ts` (the tile-keys assertion from Task 7 moves from four keys to six)

**Interfaces:**
- Consumes: nothing from Tasks 8-10.
- Produces:
  - `export interface KeyHealth { readonly configured: number; readonly oldestAgeDays: number }`
  - `export async function readKeyHealth(projectId: string, secretNames: ReadonlyArray<string>): Promise<KeyHealth>`
  - Two more KPI keys on `GET /api/admin/apps/kora/kpis`: `ai_keys_configured`, `ai_key_age_days`.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/web && npm install @google-cloud/secret-manager
```
Confirm it lands in `dependencies`, not `devDependencies`, and that `package-lock.json` is updated. This is the one place Phase 1 adds backend code to tesserix-home — the spec's "no new backend code" held for the Prometheus panels and stops holding here, which is expected and worth saying in the PR body.

- [ ] **Step 2: Write the failing tests**

Create `apps/web/lib/secrets/__tests__/key-health.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const listSecretVersions = vi.fn();
const accessSecretVersion = vi.fn();

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: class {
    listSecretVersions = listSecretVersions;
    accessSecretVersion = accessSecretVersion;
  },
}));

import { readKeyHealth } from "../key-health";

const DAY = 24 * 60 * 60 * 1000;
function versionsCreatedDaysAgo(...days: number[]) {
  return [
    days.map((d) => ({
      state: "ENABLED",
      createTime: { seconds: Math.floor((Date.now() - d * DAY) / 1000) },
    })),
  ];
}

beforeEach(() => {
  listSecretVersions.mockReset();
  accessSecretVersion.mockReset();
});

describe("readKeyHealth", () => {
  it("counts enabled keys and reports the age of the OLDEST current version", async () => {
    listSecretVersions.mockImplementation(({ parent }: { parent: string }) =>
      parent.endsWith("gemini") ? versionsCreatedDaysAgo(7) : versionsCreatedDaysAgo(30),
    );

    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health.configured).toBe(2);
    // The oldest key is the one at risk, so the tile must surface 30, not 7.
    expect(health.oldestAgeDays).toBe(30);
  });

  // The whole point of the tile: a key that vanished or was disabled must
  // show up as a DROP, not as a silently smaller set.
  it("does not count a secret with no enabled version", async () => {
    listSecretVersions.mockImplementation(({ parent }: { parent: string }) =>
      parent.endsWith("gemini")
        ? versionsCreatedDaysAgo(7)
        : [[{ state: "DESTROYED", createTime: { seconds: 1 } }]],
    );

    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health.configured).toBe(1);
    expect(health.oldestAgeDays).toBe(7);
  });

  it("degrades to zeros when Secret Manager is unreachable", async () => {
    listSecretVersions.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const health = await readKeyHealth("p", ["gemini", "openai"]);
    expect(health).toEqual({ configured: 0, oldestAgeDays: 0 });
  });

  // THE SECURITY BOUNDARY. This module reads metadata and must never pull a
  // secret VALUE into the portal process. Without this test, someone
  // "improving" the panel to show a key prefix would face nothing at all.
  it("never accesses a secret value", async () => {
    listSecretVersions.mockImplementation(() => versionsCreatedDaysAgo(3));
    await readKeyHealth("p", ["gemini", "openai"]);
    expect(accessSecretVersion).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/secrets`
Expected: FAIL — `Cannot find module '../key-health'`.

- [ ] **Step 4: Implement**

Create `apps/web/lib/secrets/key-health.ts`:

```ts
// Read-only health of a product's AI provider keys.
//
// METADATA ONLY: this module calls listSecretVersions and NEVER
// accessSecretVersion, so no secret value is ever pulled into the portal
// process. A test pins that. If you are here to add a "show the key prefix"
// affordance, that is a different feature with a different threat model —
// design it, don't bolt it on.
//
// Rotation is deliberately NOT offered here. Kora's keys arrive as pod ENV
// VARS via an ExternalSecret with a 1h refreshInterval, so writing a new
// version rotates nothing until ESO refreshes AND the pod restarts. A button
// that writes a version and reports success would be lying about a
// three-step operation.
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

import { logger } from "@/lib/logger";

export interface KeyHealth {
  readonly configured: number;
  readonly oldestAgeDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let client: SecretManagerServiceClient | null = null;
function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

// Age of a secret's newest ENABLED version, in whole days. null when the
// secret has no usable version at all — which is the state worth alarming on.
async function currentVersionAgeDays(projectId: string, name: string): Promise<number | null> {
  const [versions] = await getClient().listSecretVersions({
    parent: `projects/${projectId}/secrets/${name}`,
  });

  let newestSeconds = 0;
  for (const v of versions ?? []) {
    if (v.state !== "ENABLED") continue;
    const seconds = Number(v.createTime?.seconds ?? 0);
    if (seconds > newestSeconds) newestSeconds = seconds;
  }
  if (newestSeconds === 0) return null;
  return Math.floor((Date.now() - newestSeconds * 1000) / MS_PER_DAY);
}

// readKeyHealth reports how many of the named secrets have a usable version,
// and how stale the STALEST of them is — the oldest key is the one at risk, so
// a fresh rotation of one key must not mask another that was never touched.
export async function readKeyHealth(
  projectId: string,
  secretNames: ReadonlyArray<string>,
): Promise<KeyHealth> {
  try {
    const ages = await Promise.all(
      secretNames.map((name) => currentVersionAgeDays(projectId, name)),
    );
    const usable = ages.filter((a): a is number => a !== null);
    return {
      configured: usable.length,
      oldestAgeDays: usable.length > 0 ? Math.max(...usable) : 0,
    };
  } catch (err) {
    logger.warn(`[key-health] ${err instanceof Error ? err.message : "failed"}`);
    return { configured: 0, oldestAgeDays: 0 };
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run lib/secrets && npm run typecheck`
Expected: PASS, `tsc` exit 0.

- [ ] **Step 6: Mutation-verify**

1. Change `Math.max(...usable)` to `Math.min(...usable)`.
   Expected: the oldest-version test fails on `expected 7 to be 30`. Revert.
2. Delete the `if (v.state !== "ENABLED") continue;` line.
   Expected: the no-enabled-version test fails on `expected 2 to be 1`. Revert.
3. Add a throwaway `await getClient().accessSecretVersion({ name: "x" });` inside `readKeyHealth`.
   Expected: the security-boundary test fails on `expected "accessSecretVersion" to not be called`. Revert.
4. Remove the `try/catch`, letting the rejection propagate.
   Expected: the unreachable test fails with the raw `PERMISSION_DENIED`. Revert.

Confirm `git diff` clean.

- [ ] **Step 7: Wire it into the KPI route and the tiles**

In the `kora` branch of `apps/web/app/api/admin/apps/[product]/kpis/route.ts`, after the `await Promise.all(...)` over `queries` and before the `return`:

```ts
    // AI provider key health. Metadata only — see lib/secrets/key-health.ts.
    // Independent of the Prometheus block above: a Secret Manager failure must
    // blank these two tiles, not the four operating ones.
    const keys = await readKeyHealth("tesseracthub-480811", [
      "prod-kora-gemini-api-key",
      "prod-kora-openai-api-key",
    ]);
    out.ai_keys_configured = keys.configured;
    out.ai_key_age_days = keys.oldestAgeDays;
```

with `import { readKeyHealth } from "@/lib/secrets/key-health";` at the top. `readKeyHealth` never throws, so no extra `try` is needed — confirm that by reading it rather than trusting this sentence.

In `apps/web/lib/products/configs.ts`, append two tiles to `kora.businessKpiTiles`:

```ts
    { key: "ai_keys_configured", label: "AI keys configured", hint: "gemini + openai — should be 2", source: "product" },
    { key: "ai_key_age_days", label: "Oldest AI key", hint: "days since last rotation", source: "product" },
```

and update the Task 7 test's expected array to the six keys in order:

```ts
    expect(keys).toEqual([
      "food_index_missing",
      "ai_calls_24h",
      "ai_failures_24h",
      "decompose_over_budget_pct",
      "ai_keys_configured",
      "ai_key_age_days",
    ]);
```

- [ ] **Step 8: Verify the whole suite and the rendered page**

Run: `cd apps/web && npm run typecheck && npm run lint && npx vitest run`
Expected: all green.

Then on the dev server, `/admin/apps/kora` should show six tiles plus the layout's own "Critical events (24h)". As of 2026-08-05 `prod-kora-gemini-api-key` has exactly **one** version, created **2026-07-29** — so expect `AI keys configured = 2` and `Oldest AI key ≈ 7` days and rising. If `configured` reads 0, the portal could not reach Secret Manager; check the pod's Workload Identity binding before assuming the code is wrong.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/lib/secrets apps/web/lib/products/configs.ts apps/web/lib/products/__tests__/configs.test.ts "apps/web/app/api/admin/apps/[product]/kpis/route.ts"
git commit -m "feat(admin): read-only ai provider key health for kora"
```

---

## Findings to report (not to fix here)

- **The portal's GSA holds project-level `roles/secretmanager.admin`.** `app-secrets-marketplace-prod@tesseracthub-480811` can add versions to, and destroy, *every* secret in the project — every product's AI keys, database URLs and tokens — plus it carries `roles/serviceusage.apiKeysAdmin` and `roles/firebaseauth.admin`. Nothing in the portal's code exercises that today, so the only thing standing between a portal-side code defect and a credential write is that no such code path exists. Task 11 deliberately does not add one. Worth its own security review; do not widen, and do not narrow it blind either.
- **`prod-kora-gemini-api-key` has one version, created 2026-07-29, and has never been rotated.** Same expected for the OpenAI key — confirm.
- **"Has the pod actually picked up a rotation?" is not answerable from the data available.** `kube_pod_start_time` is not among the `kube_pod_*` descriptors GMP ingests, and the portal has no Kubernetes client. Deliberately deferred rather than approximated — an approximate answer to "did the rotation land?" is worse than no answer.

## Final whole-branch verification

After all three parts are merged and deployed:

- [ ] `/admin/apps/kora` shows **Food index gaps = 4078** (or whatever the database then holds — cross-check with the SQL from Task 4 Step 4, and note that this number only moves when the embed job runs and the Gemini free-tier daily quota allows).
- [ ] **AI calls (24h)** and **AI failures (24h)** carry numbers. Both will be small; `coach` and `transcribe` have never recorded a call in prod.
- [ ] **Decompose over budget** carries a number. If `decompose` has had no calls in 24h this is legitimately `0` from the `Number.isFinite` guard, not a bug — confirm which by running the raw PromQL against `gmp-frontend` before concluding anything.
- [ ] **AI keys configured = 2** and **Oldest AI key** carries a plausible day count (≈7 and rising as of 2026-08-05). A `0` for configured means the portal could not reach Secret Manager, not that the keys are gone — check before alarming anyone.
- [ ] Resources (cpu/mem/pods) carries numbers — this is Part B working.
- [ ] The Database panel may still read `—`: `cnpg_*` has zero descriptors in GMP. **Report this rather than absorbing it.** Fixing it means adding GMP `PodMonitoring` resources for the CNPG clusters, which is its own piece of work affecting every product.
- [ ] Append the outcome to `.superpowers/sdd/progress.md`: what shipped, the running digest, the observed numbers, and anything that turned out differently from this plan.

## Explicitly out of scope for Phase 1

- **Any write action.** Read-only; writes need the Phase 3 admin API.
- **AI key rotation.** Task 11 reports key *health* and nothing more. Rotation is a three-step operation (write a Secret Manager version → wait for the ExternalSecret's 1h refresh → restart the pod, because the keys are env vars), it needs an audit trail and a confirmation flow, and it wants designing across every product rather than Kora-first. Its own brainstorm, its own phase.
- **Per-user anything.** Prometheus carries no `user_id` label by design.
- **A Grafana dashboard.** The portal is the surface.
- **Phases 2–4.** Scoped, not designed — each needs its own brainstorm. Do not drift into them.
- **CNPG GMP PodMonitorings.** Surfaced by this work, not part of it.
- **The Kora Postgres cutover.** Staged and awaiting a human-present session (`docs/runbooks/kora-postgres-cutover.md`). The app still reads `kora_db` on `global-postgres`; `cnpgClusterName: "kora-postgres"` is nonetheless correct, because it names the cluster the DB panels should describe going forward.
