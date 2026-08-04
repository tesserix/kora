package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
)

// bucketCount reads the cumulative count of histogram h's bucket whose upper
// bound is le, via the Prometheus wire representation (Write) rather than any
// convenience helper — testutil has nothing that reads a single bucket's
// value, only series counts (CollectAndCount) or single-float metrics
// (ToFloat64), neither of which can tell an observation's VALUE from its mere
// existence. That gap is exactly what let `Observe(0)` sail through here
// undetected before this test existed.
func bucketCount(t *testing.T, h prometheus.Histogram, le float64) uint64 {
	t.Helper()
	var m dto.Metric
	if err := h.Write(&m); err != nil {
		t.Fatalf("write histogram metric: %v", err)
	}
	for _, b := range m.GetHistogram().GetBucket() {
		if b.GetUpperBound() == le {
			return b.GetCumulativeCount()
		}
	}
	t.Fatalf("no bucket with le=%v in histogram (buckets: %v)", le, latencyBuckets)
	return 0
}

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

// THE VALUE, not just the series. CollectAndCount (above) only proves an
// observation happened, not what it observed — a reviewer proved this by
// swapping the real `Observe(latency.Seconds())` for `Observe(0)` and finding
// the package suite still green. A 20s call must land at/under the 20s
// bucket and strictly above the 10s bucket; if the value collapses to 0 (or
// to nanoseconds, per the ms→Duration bug this guards in billing.Meter), it
// lands in every bucket including 10s, and this test catches that.
func TestRecordAICallLatencyObservesTheActualDuration(t *testing.T) {
	c := New()
	c.RecordAICall("identify_photo", "gemini-3.5-flash", "ok", 0.002, 20*time.Second)

	hist, ok := c.aiLatency.WithLabelValues("identify_photo", "ok").(prometheus.Histogram)
	if !ok {
		t.Fatalf("WithLabelValues did not return a prometheus.Histogram")
	}

	if got := bucketCount(t, hist, 20); got != 1 {
		t.Errorf("le=20 bucket count = %d, want 1 (a 20s observation must land at/under the 20s bucket)", got)
	}
	if got := bucketCount(t, hist, 10); got != 0 {
		t.Errorf("le=10 bucket count = %d, want 0 (a 20s observation must NOT be visible from the 10s bucket)", got)
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
