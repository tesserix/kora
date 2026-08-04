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
