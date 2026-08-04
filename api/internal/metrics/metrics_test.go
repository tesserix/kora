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
