# Design — Prometheus `/metrics` exporter for the Kora API (#43)

Date: 2026-08-04. Issue: #43 (feat: success metrics & product instrumentation).

## Why now

#43's own revised recommendation ordered the work: settle the taxonomy, fix
`food_logs.source` to follow the resolution rather than the open capture tab,
exercise the AI modalities in prod at least once, *then* build the exporter.
The first three are done — the taxonomy was settled in the issue comments,
`sourceForMode()` is gone (#80 replaced it with an explicit
`applyResolution(data, "ai_photo"|"ai_text"|"ai_voice")` at each resolve site),
and photo resolved successfully against prod on 2026-08-04. Voice and coach
still have zero support, which is a data gap, not a blocker for exposure.

## A finding that shapes the design

`food_logs.source` is taken **verbatim from the client**. `foodlog/service.go`
validates `meal_slot` against `validMealSlots` and rejects a non-positive
`quantity_grams`, but `source` gets only an empty-string default:

```go
source := req.Source
if source == "" {
    source = "manual"
}
```

As a Prometheus label under GCP Managed Prometheus — which bills per sample
ingested — an unvalidated client string is an unbounded-cardinality hazard.
Any authenticated user could inflate both the series count and the bill, and
permanently pollute the photo-share number that #43 exists to produce and that
gates pricing (#41).

The exporter therefore allowlists at its own boundary (see Label hygiene).
Tightening the *API* to reject an unknown `source` outright is the more
complete fix, but it changes request-handling semantics and does not belong in
a metrics change. **To be filed as its own issue.**

## Architecture

One new package, `internal/metrics`, owns the Prometheus registry and the
collectors. It accepts only primitives (`string`, `float64`,
`time.Duration`), so it imports nothing from `ai`, `billing` or `foodlog`,
stays independently testable, and confines the Prometheus dependency to a
single package.

### Call sites

| Site | Trigger | Note |
|---|---|---|
| `billing.Meter.Record` | every metered AI provider call | the single funnel |
| `foodlog.Repository.Create` | successful insert | |
| `foodlog.Repository.CreateIdempotent` | **only** `res.RowsAffected > 0` | a replay must not count |

`billing.Meter.Record` has exactly two callers — `ai/resolver.go:330` and
`coach/service.go:248` — so instrumenting there covers resolve *and* coach,
including the abandoned fallback legs that `recordAll` already feeds it (#81).

Two invariants that are easy to get wrong and are pinned by tests:

1. **The counter increments independently of the DB insert result.** The
   provider call happened, and was billed by the provider, whether or not our
   `ai_usage_events` row landed. Metering the row and metering the call are
   different questions.
2. **`CreateIdempotent` counts only a real insert.** The offline queue (#22)
   replays writes whose response was lost, and `RowsAffected == 0` means the
   row already existed. Counting a replay would inflate precisely the pricing
   number this work exists to produce.

## Metrics

```
kora_ai_calls_total{class,call_type,model,outcome}      counter
kora_ai_cost_usd_total{class,call_type,model,outcome}   counter
kora_ai_latency_seconds{call_type,outcome}              histogram
kora_food_logs_total{source}                            counter
```

`kora_ai_cost_usd_total` carries the same labels as the call counter so that
"what did the failures cost us" is answerable. Per `docs/ai-usage-queries.md`,
spend is a **resource** question and is summed unfiltered; emitting `outcome`
as a label rather than filtering at write time keeps both the resource and the
product view derivable from one series.

### Histogram buckets

`.25, .5, 1, 1.5, 2, 3, 5, 10, 20, 30, 60, 100` (seconds).

Deliberately aligned to the thresholds this system makes decisions at, not the
client library defaults: `1.5` is `textBudget`, `20` is `photoBudget`, `30` is
`transcribeBudget`, `100` is the gateway's `perTryTimeout` after #79. "How
often does the fast path miss its budget?" then reads off a bucket boundary
directly. This is the metric that would have made `photoBudget = 3s` obvious
on day one instead of costing a full debug cycle, and it is how the open
question about `textBudget = 1500ms` gets settled with production data rather
than laptop measurements.

## Label hygiene

Every label is mapped through a closed set; anything unrecognised becomes
`"other"`.

| Label | Allowed values |
|---|---|
| `call_type` | `identify_photo`, `identify_text`, `transcribe`, `coach`, `decompose`, `embed` |
| `class` | `resolution` (identify_photo/identify_text/transcribe/coach), `derived` (decompose/embed) |
| `outcome` | `ok`, `error`, `timeout` |
| `source` | `ai_photo`, `ai_text`, `ai_voice`, `ai_barcode`, `manual`, `memory`, `meal` |

`class` is derived from `call_type`, so the two can never disagree.

A non-zero `kora_food_logs_total{source="other"}` is itself a signal: either a
new legitimate source shipped without updating the allowlist, or something is
sending junk. The same applies to `call_type="other"`. This trades a silently
wrong label for a visible one — accepted deliberately, with the cost noted that
a mis-typed `call_type` disappears into a bucket rather than announcing itself.

`model` is not allowlisted. Its values come from Go consts
(`gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-embedding-001`) and the
operator-set `OPENAI_MODEL` env var, none of which are user-controlled.

## Exposure

A second `http.Server` on `:9090` serving only `promhttp.Handler()`, started
from `main.go` and shut down through the existing graceful path. It is not
routed through the Istio gateway, so `/metrics` is never publicly reachable and
no authentication question arises.

`tesserix-k8s` gains a `PodMonitoring` matching the cluster's existing
convention (`port: 9090`, `path: /metrics`, `interval: 30s`), as used by
`k8s/cluster/monitoring/gcp-managed-prometheus.yaml`. Note that repo's CI does
not validate `manifests/**` (see the handoff), so the manifest needs
`kubectl apply --dry-run=server` by hand.

## Testing

Registry-level assertions with `prometheus/testutil`: increment, then read back
the exact label set and value. Three carry real risk and are each
mutation-verified — break the behaviour, confirm the failure lands on that
test's own assertion, revert, confirm a clean `git diff`:

1. An idempotent **replay must not increment** `kora_food_logs_total`.
2. A **failed `Meter.Record` DB write must still increment** the call counter.
3. An **unknown `source` lands on `"other"`** and does not create a new series.

The third is the one that protects the billing surface, so it asserts the
absence of a new series, not merely the presence of the `other` one.

## Out of scope

- **Active-user gauge.** Inherently a question about DB state, not a count of
  events this process observed. Belongs in #43's SQL rollup (item 3).
- **Grafana dashboard JSON.** Deferred until there is non-zero data behind it —
  voice and coach have never recorded a call, so panels would be built against
  empty series.
- **API-level `source` validation.** To be filed as its own issue; see the
  finding above.
