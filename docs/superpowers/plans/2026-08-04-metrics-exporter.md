# Prometheus Metrics Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Kora's AI-cost and food-log instrumentation as Prometheus metrics on a private `:9090` endpoint, scraped by GCP Managed Prometheus.

**Architecture:** A self-contained `internal/metrics` package owns a dedicated Prometheus registry and four collectors, and accepts only primitives so it imports nothing from `ai`, `billing` or `foodlog`. Three existing funnels call into it: `billing.Meter.Record` (covers both resolve and coach), `foodlog.Repository.Create`, and `foodlog.Repository.CreateIdempotent`. A second `http.Server` in `main.go` serves `/metrics` on a port that is never routed through the Istio gateway.

**Tech Stack:** Go 1.26, `github.com/prometheus/client_golang`, `stretchr/testify` v1.11.1, GORM, Helm, GCP Managed Prometheus (`monitoring.googleapis.com/v1` `PodMonitoring`).

**Spec:** `docs/superpowers/specs/2026-08-04-metrics-exporter-design.md`

## Global Constraints

- Module path is `github.com/tesserix/kora/api`. All imports use that prefix.
- Go tests run from `api/`: `go test ./...` and `go vet ./...` must both pass.
- DB-backed tests need `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'`. Both `internal/billing` and `internal/foodlog` already have a `testDB(t)` helper in their existing `_test.go` files that skips when the variable is unset — reuse it, do not write a new one.
- **Run all test commands in the FOREGROUND.** Backgrounded runs stall in this environment.
- Commits are **single-line conventional commits**. No body, no trailers, no signature.
- **Every test must be mutation-verified**: break the behaviour the test names, confirm it fails on *that test's own assertion* (read the failure message — a test that fails for the wrong reason is a false red that becomes a false green the moment you "fix" the wrong thing), then revert and confirm `git diff` is clean.
- No label may carry a user-controlled unbounded value. GCP Managed Prometheus bills per sample ingested.
- Do **not** run `npx expo lint`, `eas build`, or any mobile tooling — this plan does not touch `apps/mobile`.

---

### Task 1: The `internal/metrics` package

**Files:**
- Create: `api/internal/metrics/labels.go`
- Create: `api/internal/metrics/labels_test.go`
- Create: `api/internal/metrics/metrics.go`
- Create: `api/internal/metrics/metrics_test.go`
- Modify: `api/go.mod`, `api/go.sum` (add `github.com/prometheus/client_golang`)

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 2–4:
  - `metrics.RecordAICall(callType, model, outcome string, costUSD float64, latency time.Duration)`
  - `metrics.RecordFoodLog(source string)`
  - `metrics.Handler() http.Handler`
  - `metrics.Default() *Collectors` (tests read counters through this)
  - `(*Collectors).RecordAICall`, `(*Collectors).RecordFoodLog`, `(*Collectors).Handler`, `metrics.New() *Collectors`

- [ ] **Step 1: Add the Prometheus client dependency**

```bash
cd api
go get github.com/prometheus/client_golang
go mod tidy
```

Expected: `github.com/prometheus/client_golang` appears in `api/go.mod`. Record the resolved version in the commit message body-less subject if useful, but do not pin it by hand.

- [ ] **Step 2: Write the failing label tests**

Create `api/internal/metrics/labels_test.go`:

```go
package metrics

import "testing"

func TestNormalizeCallTypeKeepsKnownValues(t *testing.T) {
	for _, ct := range []string{"identify_photo", "identify_text", "transcribe", "coach", "decompose", "embed"} {
		if got := normalizeCallType(ct); got != ct {
			t.Errorf("normalizeCallType(%q) = %q, want %q", ct, got, ct)
		}
	}
}

func TestNormalizeCallTypeBucketsUnknownValues(t *testing.T) {
	if got := normalizeCallType("identify_hologram"); got != "other" {
		t.Errorf("normalizeCallType(unknown) = %q, want \"other\"", got)
	}
	if got := normalizeCallType(""); got != "other" {
		t.Errorf("normalizeCallType(empty) = %q, want \"other\"", got)
	}
}

func TestClassForSplitsResolutionFromDerived(t *testing.T) {
	resolution := []string{"identify_photo", "identify_text", "transcribe", "coach"}
	derived := []string{"decompose", "embed"}
	for _, ct := range resolution {
		if got := classFor(ct); got != "resolution" {
			t.Errorf("classFor(%q) = %q, want \"resolution\"", ct, got)
		}
	}
	for _, ct := range derived {
		if got := classFor(ct); got != "derived" {
			t.Errorf("classFor(%q) = %q, want \"derived\"", ct, got)
		}
	}
	if got := classFor("identify_hologram"); got != "other" {
		t.Errorf("classFor(unknown) = %q, want \"other\"", got)
	}
}

func TestNormalizeOutcome(t *testing.T) {
	for _, oc := range []string{"ok", "error", "timeout"} {
		if got := normalizeOutcome(oc); got != oc {
			t.Errorf("normalizeOutcome(%q) = %q, want %q", oc, got, oc)
		}
	}
	if got := normalizeOutcome("cancelled"); got != "other" {
		t.Errorf("normalizeOutcome(unknown) = %q, want \"other\"", got)
	}
}

// normalizeSource is the one that protects the billing surface: food_logs.source
// arrives verbatim from the client and is not validated by the API.
func TestNormalizeSource(t *testing.T) {
	for _, s := range []string{"ai_photo", "ai_text", "ai_voice", "ai_barcode", "manual", "memory", "meal"} {
		if got := normalizeSource(s); got != s {
			t.Errorf("normalizeSource(%q) = %q, want %q", s, got, s)
		}
	}
	if got := normalizeSource("'; DROP TABLE food_logs; --"); got != "other" {
		t.Errorf("normalizeSource(hostile) = %q, want \"other\"", got)
	}
}
```

- [ ] **Step 3: Run the label tests to verify they fail**

Run: `cd api && go test ./internal/metrics/ -run 'TestNormalize|TestClassFor' -v`
Expected: FAIL — build error, `undefined: normalizeCallType`.

- [ ] **Step 4: Implement the label allowlists**

Create `api/internal/metrics/labels.go`:

```go
package metrics

// Known AI call types. Anything outside this set is recorded as labelOther, so
// a typo, a new call type, or a hostile value can never create unbounded label
// cardinality.
const (
	callIdentifyPhoto = "identify_photo"
	callIdentifyText  = "identify_text"
	callTranscribe    = "transcribe"
	callCoach         = "coach"
	callDecompose     = "decompose"
	callEmbed         = "embed"
)

// labelOther is the sink for any value outside a known set. A non-zero count on
// it is itself a signal: either a new legitimate value shipped without updating
// these tables, or something is sending junk. This deliberately trades a
// silently wrong label for a visible one — the cost being that a mistyped
// call_type disappears into a bucket rather than announcing itself.
const labelOther = "other"

// COGS classes, settled in issue #43. `resolution` is the headline number and is
// comparable between users; `derived` scales with meal complexity (decompose)
// and corrections (embed), so folding it into a per-log ratio would make that
// ratio uninterpretable. Total COGS is the sum of both.
const (
	classResolution = "resolution"
	classDerived    = "derived"
)

var classByCallType = map[string]string{
	callIdentifyPhoto: classResolution,
	callIdentifyText:  classResolution,
	callTranscribe:    classResolution,
	callCoach:         classResolution,
	callDecompose:     classDerived,
	callEmbed:         classDerived,
}

// Mirrors ai.OutcomeOK / OutcomeError / OutcomeTimeout. Duplicated as literals
// rather than imported so this package stays free of any dependency on ai.
var knownOutcomes = map[string]bool{"ok": true, "error": true, "timeout": true}

// The sources the mobile app can send, plus "memory" which the server itself
// writes in foodlog.Service.CreateBatch.
var knownSources = map[string]bool{
	"ai_photo": true, "ai_text": true, "ai_voice": true, "ai_barcode": true,
	"manual": true, "memory": true, "meal": true,
}

func normalizeCallType(callType string) string {
	if _, ok := classByCallType[callType]; ok {
		return callType
	}
	return labelOther
}

// classFor derives the class from the call type, so the two labels can never
// disagree with each other.
func classFor(callType string) string {
	if class, ok := classByCallType[callType]; ok {
		return class
	}
	return labelOther
}

func normalizeOutcome(outcome string) string {
	if knownOutcomes[outcome] {
		return outcome
	}
	return labelOther
}

func normalizeSource(source string) string {
	if knownSources[source] {
		return source
	}
	return labelOther
}
```

- [ ] **Step 5: Run the label tests to verify they pass**

Run: `cd api && go test ./internal/metrics/ -run 'TestNormalize|TestClassFor' -v`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing collector tests**

Create `api/internal/metrics/metrics_test.go`:

```go
package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestRecordAICallIncrementsCallsCostAndLatency(t *testing.T) {
	c := New()
	c.RecordAICall("identify_text", "gemini-3.5-flash-lite", "ok", 0.0004, 884*time.Millisecond)

	calls := testutil.ToFloat64(c.aiCalls.WithLabelValues("resolution", "identify_text", "gemini-3.5-flash-lite", "ok"))
	if calls != 1 {
		t.Errorf("calls = %v, want 1", calls)
	}
	cost := testutil.ToFloat64(c.aiCostUSD.WithLabelValues("resolution", "identify_text", "gemini-3.5-flash-lite", "ok"))
	if cost != 0.0004 {
		t.Errorf("cost = %v, want 0.0004", cost)
	}
	if got := testutil.CollectAndCount(c.aiLatency); got != 1 {
		t.Errorf("latency series = %d, want 1", got)
	}
}

// decompose and embed must land in the `derived` class, not `resolution` —
// this is the whole point of the two-counter taxonomy settled in #43.
func TestRecordAICallClassifiesDerivedCalls(t *testing.T) {
	c := New()
	c.RecordAICall("embed", "gemini-embedding-001", "ok", 0, 435*time.Millisecond)

	if got := testutil.ToFloat64(c.aiCalls.WithLabelValues("derived", "embed", "gemini-embedding-001", "ok")); got != 1 {
		t.Errorf("derived embed count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(c.aiCalls.WithLabelValues("resolution", "embed", "gemini-embedding-001", "ok")); got != 0 {
		t.Errorf("embed leaked into resolution class: %v", got)
	}
}

// A failed call still costs money and still consumed provider quota, so it is
// recorded with its outcome rather than dropped. See docs/ai-usage-queries.md.
func TestRecordAICallKeepsFailuresWithTheirOutcome(t *testing.T) {
	c := New()
	c.RecordAICall("identify_photo", "gemini-3.5-flash", "timeout", 0.002, 20*time.Second)

	if got := testutil.ToFloat64(c.aiCalls.WithLabelValues("resolution", "identify_photo", "gemini-3.5-flash", "timeout")); got != 1 {
		t.Errorf("timeout count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(c.aiCostUSD.WithLabelValues("resolution", "identify_photo", "gemini-3.5-flash", "timeout")); got != 0.002 {
		t.Errorf("timeout cost = %v, want 0.002", got)
	}
}

func TestRecordFoodLogCountsBySource(t *testing.T) {
	c := New()
	c.RecordFoodLog("ai_photo")
	c.RecordFoodLog("ai_photo")
	c.RecordFoodLog("manual")

	if got := testutil.ToFloat64(c.foodLogs.WithLabelValues("ai_photo")); got != 2 {
		t.Errorf("ai_photo = %v, want 2", got)
	}
	if got := testutil.ToFloat64(c.foodLogs.WithLabelValues("manual")); got != 1 {
		t.Errorf("manual = %v, want 1", got)
	}
}

// THE BILLING GUARD. An unknown source must NOT create its own series — under
// GCP Managed Prometheus (billed per sample ingested) a client-controlled label
// is a cost as well as a correctness problem, and food_logs.source is passed
// through unvalidated by the API. Asserting the SERIES COUNT is the point;
// asserting only that "other" incremented would still pass if a new series
// were also created.
func TestRecordFoodLogDoesNotCreateSeriesForUnknownSources(t *testing.T) {
	c := New()
	c.RecordFoodLog("ai_photo")
	before := testutil.CollectAndCount(c.foodLogs)

	c.RecordFoodLog("attacker-controlled-1")
	c.RecordFoodLog("attacker-controlled-2")
	c.RecordFoodLog("attacker-controlled-3")

	after := testutil.CollectAndCount(c.foodLogs)
	if after != before+1 {
		t.Errorf("series count went %d -> %d; want exactly one new series (the shared \"other\")", before, after)
	}
	if got := testutil.ToFloat64(c.foodLogs.WithLabelValues("other")); got != 3 {
		t.Errorf("other = %v, want 3", got)
	}
}

func TestHandlerServesTheRegisteredMetrics(t *testing.T) {
	c := New()
	c.RecordAICall("transcribe", "gemini-3.5-flash", "ok", 0.001, 3912*time.Millisecond)

	req := httptest.NewRequest("GET", "/metrics", nil)
	rec := httptest.NewRecorder()
	c.Handler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"kora_ai_calls_total",
		"kora_ai_cost_usd_total",
		"kora_ai_latency_seconds_bucket",
		`call_type="transcribe"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
}

// The buckets are aligned to this system's actual decision thresholds rather
// than the client library defaults. If someone "tidies" them to the defaults,
// the budget questions stop being answerable off a bucket boundary.
func TestLatencyBucketsCoverTheBudgetThresholds(t *testing.T) {
	for _, want := range []float64{1.5, 20, 30, 100} {
		found := false
		for _, b := range latencyBuckets {
			if b == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("latencyBuckets missing %v (a budget threshold)", want)
		}
	}
}
```

- [ ] **Step 7: Run the collector tests to verify they fail**

Run: `cd api && go test ./internal/metrics/ -v`
Expected: FAIL — build error, `undefined: New`.

- [ ] **Step 8: Implement the collectors**

Create `api/internal/metrics/metrics.go`:

```go
// Package metrics exposes the Kora API's Prometheus instrumentation.
//
// It deliberately accepts only primitives, so it imports nothing from ai,
// billing or foodlog and can be tested entirely on its own. Every label passes
// through a closed allowlist (labels.go) before it reaches a collector.
//
// The registry is dedicated rather than prometheus.DefaultRegisterer, and the
// Go/process collectors are deliberately NOT registered: scraping is done by
// GCP Managed Prometheus, which bills per sample ingested, so the exported
// surface is kept to the four series this product actually reasons about.
package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// latencyBuckets are aligned to the thresholds this system makes decisions at,
// not the client library defaults: 1.5s is ai.textBudget, 20s ai.photoBudget,
// 30s ai.transcribeBudget, and 100s the Istio gateway's perTryTimeout after
// #79. "How often does the fast path miss its budget?" is then a read off a
// bucket boundary — the question that cost a full debug cycle when
// photoBudget was 3s.
var latencyBuckets = []float64{0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 20, 30, 60, 100}

// Collectors holds the exported metrics and the registry they live on.
type Collectors struct {
	registry  *prometheus.Registry
	aiCalls   *prometheus.CounterVec
	aiCostUSD *prometheus.CounterVec
	aiLatency *prometheus.HistogramVec
	foodLogs  *prometheus.CounterVec
}

// New builds an independent set of collectors on their own registry. Tests use
// this for isolation; production uses the package-level default.
func New() *Collectors {
	c := &Collectors{
		registry: prometheus.NewRegistry(),
		aiCalls: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kora_ai_calls_total",
			Help: "AI provider calls, including failed and abandoned fallback legs.",
		}, []string{"class", "call_type", "model", "outcome"}),
		aiCostUSD: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kora_ai_cost_usd_total",
			Help: "Estimated AI spend in USD. Summed unfiltered, failures included: a failed call still consumed billed tokens and provider quota.",
		}, []string{"class", "call_type", "model", "outcome"}),
		aiLatency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "kora_ai_latency_seconds",
			Help:    "AI provider call latency. Buckets are aligned to the router's budget thresholds.",
			Buckets: latencyBuckets,
		}, []string{"call_type", "outcome"}),
		foodLogs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kora_food_logs_total",
			Help: "Food logs created, by resolution source.",
		}, []string{"source"}),
	}
	c.registry.MustRegister(c.aiCalls, c.aiCostUSD, c.aiLatency, c.foodLogs)
	return c
}

// RecordAICall records one AI provider call. costUSD is the estimate already
// computed by ai.EstimateCostUSD; latency is the provider-measured duration.
func (c *Collectors) RecordAICall(callType, model, outcome string, costUSD float64, latency time.Duration) {
	ct := normalizeCallType(callType)
	class := classFor(ct)
	oc := normalizeOutcome(outcome)

	c.aiCalls.WithLabelValues(class, ct, model, oc).Inc()
	c.aiCostUSD.WithLabelValues(class, ct, model, oc).Add(costUSD)
	c.aiLatency.WithLabelValues(ct, oc).Observe(latency.Seconds())
}

// RecordFoodLog records one newly created food log.
func (c *Collectors) RecordFoodLog(source string) {
	c.foodLogs.WithLabelValues(normalizeSource(source)).Inc()
}

// Handler serves this collector set in the Prometheus text format.
func (c *Collectors) Handler() http.Handler {
	return promhttp.HandlerFor(c.registry, promhttp.HandlerOpts{})
}

// defaultCollectors is the process-wide instance. A package-level default is
// used rather than threading a *Collectors through Meter and Repository
// constructors, which would ripple into every call site and test for a purely
// observational concern.
var defaultCollectors = New()

// Default returns the process-wide collectors, for tests that need to read a
// counter that production code incremented through the package functions.
func Default() *Collectors { return defaultCollectors }

// RecordAICall records one AI provider call on the default collectors.
func RecordAICall(callType, model, outcome string, costUSD float64, latency time.Duration) {
	defaultCollectors.RecordAICall(callType, model, outcome, costUSD, latency)
}

// RecordFoodLog records one newly created food log on the default collectors.
func RecordFoodLog(source string) { defaultCollectors.RecordFoodLog(source) }

// Handler serves the default collectors.
func Handler() http.Handler { return defaultCollectors.Handler() }
```

- [ ] **Step 9: Run the full package tests to verify they pass**

Run: `cd api && go test ./internal/metrics/ -v`
Expected: PASS, 12 tests.

- [ ] **Step 10: Mutation-verify the three load-bearing tests**

Do these one at a time. After each, restore the file and confirm `git diff` is clean before the next.

1. In `labels.go`, change `normalizeSource` to `return source` (drop the allowlist).
   Run: `go test ./internal/metrics/ -run TestRecordFoodLogDoesNotCreateSeriesForUnknownSources -v`
   Expected: FAIL on the **series count** assertion (`series count went 1 -> 4`), not on the `other` assertion. If it fails on a different assertion, the test is not pinning what it claims — stop and report.
   Restore. Confirm `git diff` clean.

2. In `labels.go`, make `classFor` return `classResolution` unconditionally.
   Run: `go test ./internal/metrics/ -run TestRecordAICallClassifiesDerivedCalls -v`
   Expected: FAIL on `derived embed count = 0, want 1`.
   Restore. Confirm `git diff` clean.

3. In `metrics.go`, change `latencyBuckets` to `prometheus.DefBuckets`.
   Run: `go test ./internal/metrics/ -run TestLatencyBucketsCoverTheBudgetThresholds -v`
   Expected: FAIL listing the missing thresholds 1.5, 20, 30, 100.
   Restore. Confirm `git diff` clean.

- [ ] **Step 11: Vet and commit**

```bash
cd api && go vet ./... && go test ./internal/metrics/
git add api/go.mod api/go.sum api/internal/metrics/
git commit -m "feat(api): add a metrics package with allowlisted Prometheus labels (#43)"
```

---

### Task 2: Instrument `billing.Meter.Record`

**Files:**
- Modify: `api/internal/billing/meter.go` (the `Record` method, around line 37)
- Test: `api/internal/billing/meter_test.go` (append; reuse the existing `testDB(t)` helper at line 18)

**Interfaces:**
- Consumes: `metrics.RecordAICall(callType, model, outcome string, costUSD float64, latency time.Duration)` and `metrics.Default()` from Task 1.
- Produces: nothing new. This is the single funnel for AI calls — its only two callers are `internal/ai/resolver.go:330` and `internal/coach/service.go:248`, so instrumenting here covers resolve **and** coach, including the abandoned fallback legs `recordAll` feeds it.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/billing/meter_test.go`:

```go
// The provider call happened — and was billed by the provider — whether or not
// our ai_usage_events row lands. So the counter must move even when the insert
// fails. Metering the ROW and metering the CALL are different questions, and
// conflating them would silently under-report COGS in exactly the situation
// where something is already going wrong.
func TestRecordIncrementsTheCounterEvenWhenTheInsertFails(t *testing.T) {
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close()) // every subsequent query now errors

	m := NewMeter(db)
	collectors := metrics.Default()
	before := testutil.ToFloat64(collectors.AICallsCounter("resolution", "identify_text", "test-model", "ok"))

	err = m.Record(context.Background(), uuid.New(),
		ai.Usage{Provider: "test", Model: "test-model", CallType: "identify_text", LatencyMs: 884, Outcome: "ok"}, 0.0004)

	require.Error(t, err, "insert against a closed DB must still return an error")
	after := testutil.ToFloat64(collectors.AICallsCounter("resolution", "identify_text", "test-model", "ok"))
	require.Equal(t, before+1, after, "counter must increment even though the insert failed")
}
```

This needs a small accessor on `Collectors`, because the counter fields are unexported and this test lives in another package. Add it to `api/internal/metrics/metrics.go`:

```go
// AICallsCounter exposes one labelled call counter for assertions in other
// packages' tests. Not used by production code.
func (c *Collectors) AICallsCounter(class, callType, model, outcome string) prometheus.Counter {
	return c.aiCalls.WithLabelValues(class, callType, model, outcome)
}
```

Add these imports to `meter_test.go` if absent: `"github.com/prometheus/client_golang/prometheus/testutil"`, `"github.com/tesserix/kora/api/internal/metrics"`, `"github.com/tesserix/kora/api/internal/ai"`, `"github.com/google/uuid"`, `"context"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/billing/ -run TestRecordIncrementsTheCounterEvenWhenTheInsertFails -v`
Expected: FAIL with `counter must increment even though the insert failed` — `before+1` vs `before`. **Read the message**: if it fails on `insert against a closed DB must still return an error`, the DB was not actually closed and the test is proving nothing yet.

- [ ] **Step 3: Implement**

In `api/internal/billing/meter.go`, add the import `"time"` (if absent) and `"github.com/tesserix/kora/api/internal/metrics"`, then change `Record`:

```go
// Record persists one metered AI provider call.
func (m Meter) Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error {
	// Instrumented BEFORE the insert and independently of its result: the
	// provider call already happened and was already billed upstream, whether
	// or not this row lands. See #43.
	metrics.RecordAICall(u.CallType, u.Model, u.Outcome, costUSD, time.Duration(u.LatencyMs)*time.Millisecond)

	event := Event{
		UserID:     userID,
		Provider:   u.Provider,
		Model:      u.Model,
		CallType:   u.CallType,
		TokensIn:   u.TokensIn,
		TokensOut:  u.TokensOut,
		LatencyMs:  u.LatencyMs,
		CostUSDEst: costUSD,
		Outcome:    u.Outcome,
	}
	if err := m.db.WithContext(ctx).Create(&event).Error; err != nil {
		return fmt.Errorf("billing: record: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/billing/ -v`
Expected: PASS, all existing billing tests still green (including the two `TestWithinBudgetCountsFailedCalls…` tests — do not touch `WithinBudget`).

- [ ] **Step 5: Mutation-verify**

Move the `metrics.RecordAICall(...)` line to *after* the `if err := ...; err != nil { return ... }` block, so a failed insert returns before instrumenting.
Run: `cd api && TEST_DATABASE_URL='...' go test ./internal/billing/ -run TestRecordIncrementsTheCounterEvenWhenTheInsertFails -v`
Expected: FAIL on `counter must increment even though the insert failed`.
Restore. Confirm `git diff` clean.

- [ ] **Step 6: Commit**

```bash
cd api && go vet ./...
git add api/internal/billing/meter.go api/internal/billing/meter_test.go api/internal/metrics/metrics.go
git commit -m "feat(api): meter AI calls to Prometheus at the billing funnel (#43)"
```

---

### Task 3: Instrument food-log creation

**Files:**
- Modify: `api/internal/foodlog/repository.go` (`Create` at line 34, `CreateIdempotent` at line 51)
- Test: `api/internal/foodlog/repository_test.go` (append; reuse the `testDB(t)` helper from `service_test.go:35` — same package)

**Interfaces:**
- Consumes: `metrics.RecordFoodLog(source string)` and `metrics.Default().FoodLogsCounter(source)` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the counter accessor**

In `api/internal/metrics/metrics.go`:

```go
// FoodLogsCounter exposes one labelled food-log counter for assertions in other
// packages' tests. Not used by production code.
func (c *Collectors) FoodLogsCounter(source string) prometheus.Counter {
	return c.foodLogs.WithLabelValues(source)
}
```

- [ ] **Step 2: Write the failing tests**

Append to the existing `api/internal/foodlog/repository_test.go`. It is already
`package foodlog` and already imports `context`, `testing`, `time`, `uuid`,
`require` and `nutrition`. Add only these two imports:
`"github.com/prometheus/client_golang/prometheus/testutil"` and
`"github.com/tesserix/kora/api/internal/metrics"`.

The seeding idiom below is copied from `TestUpdatePersistsFieldsForOwner` in
the same file — `seedUser(t, db)` is an existing helper, and the food item is
inlined with a `t.Cleanup` delete. There is no `seedFoodItem` helper; do not
add one.

```go
func TestCreateCountsTheLogBySource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Metrics Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	before := testutil.ToFloat64(metrics.Default().FoodLogsCounter("ai_photo"))

	_, err := repo.Create(context.Background(), FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "ai_photo", Description: item.Name, QuantityGrams: 100, Kcal: 100,
		Provenance: item.Provenance,
	})
	require.NoError(t, err)

	after := testutil.ToFloat64(metrics.Default().FoodLogsCounter("ai_photo"))
	require.Equal(t, before+1, after)
}

// THE REPLAY INVARIANT. The offline queue (#22) replays writes whose response
// was lost, and CreateIdempotent returns the already-stored row with
// RowsAffected == 0. Counting that replay would inflate precisely the
// photo-share number this instrumentation exists to produce — and it would do
// so invisibly, in proportion to how flaky the user's connection is.
func TestCreateIdempotentDoesNotCountAReplay(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Replay Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	log := FoodLog{
		ID: uuid.New(), UserID: userID, FoodItemID: &item.ID, LoggedAt: time.Now(),
		MealSlot: "lunch", Source: "ai_voice", Description: item.Name, QuantityGrams: 100,
		Kcal: 100, Provenance: item.Provenance,
	}

	before := testutil.ToFloat64(metrics.Default().FoodLogsCounter("ai_voice"))

	first, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	afterFirst := testutil.ToFloat64(metrics.Default().FoodLogsCounter("ai_voice"))
	require.Equal(t, before+1, afterFirst, "a first delivery must count")

	replay, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	require.Equal(t, first.ID, replay.ID, "a replay must return the same row")

	afterReplay := testutil.ToFloat64(metrics.Default().FoodLogsCounter("ai_voice"))
	require.Equal(t, afterFirst, afterReplay, "a replay must NOT count a second time")
}
```

Imports for the file: `"context"`, `"testing"`, `"time"`, `"github.com/google/uuid"`, `"github.com/stretchr/testify/require"`, `"github.com/prometheus/client_golang/prometheus/testutil"`, `"github.com/tesserix/kora/api/internal/metrics"`.

`seedFoodItem(t, db)` must insert one `nutrition.FoodItem` and return its `uuid.UUID`. If an equivalent helper already exists in the package's test files, use that one instead of adding a second — check `service_test.go` first.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'TestCreateCountsTheLogBySource|TestCreateIdempotentDoesNotCountAReplay' -v`
Expected: both FAIL on the counter assertions (`before+1` vs `before`). Not on a DB or seeding error — if seeding fails, fix that first; the test is proving nothing until it reaches its own assertion.

- [ ] **Step 4: Implement**

In `api/internal/foodlog/repository.go`, add the import `"github.com/tesserix/kora/api/internal/metrics"` and change both methods:

```go
func (r Repository) Create(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create: %w", err)
	}
	metrics.RecordFoodLog(created.Source)
	return created, nil
}
```

and, inside `CreateIdempotent`, only on the genuine-insert branch:

```go
	if res.RowsAffected > 0 {
		// Only a real insert counts. RowsAffected == 0 below means the offline
		// queue replayed a write whose response was lost — that is the same
		// meal, not a new one, and counting it would inflate the photo-share
		// metric in proportion to connection flakiness.
		metrics.RecordFoodLog(created.Source)
		return created, nil
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -v`
Expected: PASS, and every pre-existing foodlog test still green.

- [ ] **Step 6: Mutation-verify the replay invariant**

Move `metrics.RecordFoodLog(created.Source)` out of the `if res.RowsAffected > 0` block so it runs on every call to `CreateIdempotent`.
Run: `cd api && TEST_DATABASE_URL='...' go test ./internal/foodlog/ -run TestCreateIdempotentDoesNotCountAReplay -v`
Expected: FAIL on `a replay must NOT count a second time`.
Restore. Confirm `git diff` clean.

- [ ] **Step 7: Commit**

```bash
cd api && go vet ./...
git add api/internal/foodlog/repository.go api/internal/foodlog/repository_test.go api/internal/metrics/metrics.go
git commit -m "feat(api): count created food logs by source, skipping queue replays (#43)"
```

---

### Task 4: Serve `/metrics` on its own port

**Files:**
- Modify: `api/internal/config/config.go` (add `MetricsPort`, near `Port` at line 11 and line 30)
- Modify: `api/cmd/api/main.go` (add the second server; lines 91–115)
- Test: `api/internal/config/config_test.go` (append, or create with `package config`)

**Interfaces:**
- Consumes: `metrics.Handler() http.Handler` from Task 1.
- Produces: `config.Config.MetricsPort string`, default `"9090"`, overridable via the `METRICS_PORT` env var.

- [ ] **Step 1: Write the failing config test**

Append to `api/internal/config/config_test.go`:

```go
func TestLoadDefaultsMetricsPortTo9090(t *testing.T) {
	t.Setenv("METRICS_PORT", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "9090", cfg.MetricsPort)
}

func TestLoadReadsMetricsPortFromEnv(t *testing.T) {
	t.Setenv("METRICS_PORT", "9187")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "9187", cfg.MetricsPort)
}
```

If `Load()` requires other env vars to succeed, set them with `t.Setenv` exactly as the existing tests in this file already do — copy that setup rather than inventing new values.

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && go test ./internal/config/ -run MetricsPort -v`
Expected: FAIL — `cfg.MetricsPort undefined`.

- [ ] **Step 3: Implement the config field**

In `api/internal/config/config.go`, add to the struct next to `Port`:

```go
	MetricsPort       string
```

and in `Load()`, next to the existing `Port` line:

```go
		MetricsPort:       getenv("METRICS_PORT", "9090"),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 5: Add the metrics server to main.go**

In `api/cmd/api/main.go`, add the import `"github.com/tesserix/kora/api/internal/metrics"`, then insert after the existing `go func() { ... srv.ListenAndServe() ... }()` block (currently ending at line 102):

```go
	// Metrics listen on their own port, which is NOT routed through the Istio
	// gateway — the catch-all VirtualService rule sends / to the API's main
	// port only, so /metrics is unreachable from outside the cluster and needs
	// no auth of its own.
	metricsSrv := &http.Server{Addr: ":" + cfg.MetricsPort, Handler: metrics.Handler()}
	go func() {
		logger.Info("metrics listening", "port", cfg.MetricsPort)
		// Deliberately does NOT os.Exit on failure, unlike the API server
		// above: losing observability must never take down the product.
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("metrics server error", "err", err)
		}
	}()
```

and in the shutdown sequence, immediately before the existing `if err := srv.Shutdown(ctx); err != nil {`:

```go
	if err := metricsSrv.Shutdown(ctx); err != nil {
		logger.Error("metrics shutdown error", "err", err)
	}
```

- [ ] **Step 6: Verify it builds, vets, and actually serves**

```bash
cd api && go build ./... && go vet ./...
```
Expected: both clean.

Then confirm the endpoint really serves — a build is not evidence:

```bash
cd api && go test ./internal/metrics/ -run TestHandlerServesTheRegisteredMetrics -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/internal/config/config.go api/internal/config/config_test.go api/cmd/api/main.go
git commit -m "feat(api): serve Prometheus metrics on a private port (#43)"
```

---

### Task 5: Scrape configuration in `tesserix-k8s`

**Files (all in the sibling repo `../tesserix-k8s`, on its own branch):**
- Modify: `charts/apps/kora-api/templates/deployment.yaml` (the `ports:` block at lines 51–54)
- Create: `charts/apps/kora-api/templates/podmonitoring.yaml`
- Modify: `charts/apps/kora-api/values.yaml` (add the `metrics` block)

**Interfaces:**
- Consumes: the container listening on 9090 from Task 4.
- Produces: nothing consumed by later tasks. This is the last task.

- [ ] **Step 1: Branch**

```bash
cd ../tesserix-k8s && git checkout main && git pull && git checkout -b feat/kora-api-metrics-scrape
```

- [ ] **Step 2: Add the named container port**

In `charts/apps/kora-api/templates/deployment.yaml`, extend the existing `ports:` block:

```yaml
          ports:
            - name: http
              containerPort: {{ .Values.service.targetPort | default 8080 }}
              protocol: TCP
            - name: metrics
              containerPort: {{ .Values.metrics.port | default 9090 }}
              protocol: TCP
```

- [ ] **Step 3: Add values**

In `charts/apps/kora-api/values.yaml`, add a top-level block:

```yaml
# Prometheus metrics. Scraped in-cluster by GCP Managed Prometheus via the
# PodMonitoring below; deliberately NOT exposed through the Istio gateway.
metrics:
  enabled: true
  port: 9090
  interval: 30s
```

- [ ] **Step 4: Add the PodMonitoring**

Create `charts/apps/kora-api/templates/podmonitoring.yaml`:

```yaml
{{- if .Values.metrics.enabled }}
# GKE Autopilot runs Google Cloud Managed Service for Prometheus by default;
# a PodMonitoring is how you tell it what to scrape. Mirrors the convention in
# k8s/cluster/monitoring/gcp-managed-prometheus.yaml.
#
# NOTE: this repo's .github/workflows/pr-validation.yaml filters on charts/**,
# so this file IS covered by CI — unlike manifests/**, which is not.
apiVersion: monitoring.googleapis.com/v1
kind: PodMonitoring
metadata:
  name: {{ include "kora-api.fullname" . }}
  labels:
    {{- include "kora-api.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  selector:
    matchLabels:
      {{- include "kora-api.selectorLabels" . | nindent 6 }}
      kora.tesserix.app/stack: deployment
  endpoints:
    - port: metrics
      path: /metrics
      interval: {{ .Values.metrics.interval | default "30s" }}
{{- end }}
```

The `kora.tesserix.app/stack: deployment` selector matches what `templates/service.yaml` already uses, so the monitor follows the Deployment pods and not any leftover Knative revision pods.

- [ ] **Step 5: Render and validate**

```bash
cd ../tesserix-k8s
helm template kora-api charts/apps/kora-api | grep -A 20 "kind: PodMonitoring"
```
Expected: one PodMonitoring with `port: metrics`, `path: /metrics`, `interval: 30s`, and the two selector labels.

```bash
helm template kora-api charts/apps/kora-api | kubectl apply --dry-run=server -f -
```
Expected: every resource reports `configured` or `created (server dry run)`. A PodMonitoring error here means the CRD name or apiVersion is wrong — fix before committing.

- [ ] **Step 6: Commit and open the PR**

```bash
git add charts/apps/kora-api/
git commit -m "feat(kora): scrape the kora-api Prometheus endpoint (#43)"
git push -u origin feat/kora-api-metrics-scrape
gh pr create --title "feat(kora): scrape the kora-api Prometheus endpoint (#43)" --body "Adds a named 9090 metrics port and a PodMonitoring so GCP Managed Prometheus scrapes the new /metrics endpoint. Paired with kora#43's exporter. Validated with helm template + kubectl apply --dry-run=server."
```

---

## After all tasks

1. Open the kora PR, wait for CI, and **verify the built image digest against what CI printed** — not "successfully rolled out".
2. After deploy, compare ArgoCD's `.status.sync.revision` to git HEAD before believing "Synced/Healthy":
   `kubectl -n argocd get application <app> -o jsonpath='{.status.sync.revision}'`
3. Confirm the endpoint is live in-cluster and that the gateway does **not** expose it:
   `kubectl -n kora port-forward deploy/kora-api 9090:9090` then `curl -s localhost:9090/metrics | head`
   and `curl -s -o /dev/null -w '%{http_code}' https://kora-api.tesserix.app/metrics` — expect a non-200.
4. Confirm samples are arriving in Cloud Monitoring → Metrics Explorer (PromQL: `kora_ai_calls_total`).
5. **File the follow-up issue** the spec defers: `food_logs.source` is accepted
   verbatim from the client (`foodlog/service.go:119` only defaults `""` →
   `"manual"`, while `meal_slot` is checked against `validMealSlots`). The
   exporter allowlists at its own boundary, so the billing surface is safe, but
   the database still stores whatever a client sends. Until that issue exists,
   do not describe it anywhere as "filed".
