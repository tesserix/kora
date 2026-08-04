# Querying `ai_usage_events`

**Read this before writing any query, dashboard panel, or exporter over this
table.** It changed shape on 2026-08-04 (#81) in a way that silently alters the
meaning of queries written before that date.

## What changed

Until #81, `ai_usage_events` recorded a provider call **only when it succeeded**.
Every failed call, and the primary leg of every fallback, was dropped. So:

- COGS was a one-directional **undercount**, and
- every query was **implicitly filtered to successes** without saying so.

Since #81 the table records failures too, plus the abandoned primary leg of a
fallback, and carries an `outcome` column: `ok` | `error` | `timeout`.

**An unfiltered query that used to under-count now over-counts.** That is the
whole hazard. Nothing errors; the number just quietly changes meaning.

## The rule

Ask what the number is *for*.

### Resource questions → no filter

*"What did we actually spend?" · "How much free-tier quota is left?" ·
"Are we near the monthly cap?"*

Count **every** row. A failed call still consumed the resource:

- Providers return token usage **alongside** an error — a response that arrived
  and then failed to parse carries real, billed tokens.
- Provider quota is spent by any request that reaches the provider, answered or
  not. Cancelling our client context does not stop the upstream from processing
  or billing it.

```sql
-- True spend this month. No outcome filter: failures cost money too.
SELECT COALESCE(SUM(cost_usd_est), 0) AS spend_usd
FROM ai_usage_events
WHERE created_at >= date_trunc('month', now());
```

`billing.Meter.WithinBudget` follows this rule, and two tests fail if anyone
"fixes" it to filter.

### Product questions → filter `outcome = 'ok'`

*"AI calls per active user" · "photo share" · "median calls per log" ·
anything feeding pricing (#41) or success metrics (#43)*

Filter, or failures and retries inflate the number — and a single user tap can
now produce several rows when a fallback runs.

```sql
-- Median successful AI calls per user this month.
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median_calls
FROM (
  SELECT user_id, count(*) AS n
  FROM ai_usage_events
  WHERE outcome = 'ok'
    AND created_at >= date_trunc('month', now())
  GROUP BY user_id
) t;
```

### Reliability questions → group by it

The `outcome` column exists so this is answerable at all. `timeout` is kept
separate from `error` on purpose: *"how often does the fast path miss its
budget?"* is the question `photoBudget` and #79 both turn on, and nothing could
answer it before.

```sql
SELECT call_type, outcome, count(*)
FROM ai_usage_events
WHERE created_at >= now() - interval '7 days'
GROUP BY call_type, outcome
ORDER BY call_type, outcome;
```

## Two traps

**Zero rows never meant "unused" before #81** — a never-working path and a
never-attempted path were indistinguishable. That is how `identify_photo` and
`transcribe` sat at zero for the life of the project while genuinely broken.
Rows from before 2026-08-04 are all `outcome = 'ok'` by construction (the
migration's default), so a reliability query over that period will report a
100% success rate that is an artefact, not a fact.

**One user action can be several rows.** A resolve whose primary is abandoned
records both legs. Per-user *call* counts are therefore not per-user *action*
counts, and the ratio depends on how often the fast path misses.

## For #43's exporter

Emit `outcome` as a label rather than filtering at write time, so both the
resource and product views are derivable from one counter:

```
kora_ai_calls_total{class, call_type, model, outcome}
kora_ai_cost_usd_total{class, call_type, model, outcome}
kora_ai_latency_seconds{call_type, outcome}   # histogram
kora_food_logs_total{source}
```

Taxonomy already decided: `class=resolution` for
`identify_photo|identify_text|transcribe|coach`, `class=derived` for
`decompose|embed`. Total COGS is the sum across both.

The `outcome = 'ok'` vs. unfiltered rule above is about **SQL** over
`ai_usage_events`. The same rule applies to **PromQL** over these series, but
the syntax — and what's derivable at all — differs enough to need its own
examples.

### Resource questions → unfiltered, no `outcome` selector

```promql
# Total estimated AI spend, all time (counter — see caveat below on what
# "all time" actually means for a counter).
sum(kora_ai_cost_usd_total)

# Spend by call type, last 24h — a failed call still cost money.
sum by (call_type) (increase(kora_ai_cost_usd_total[24h]))
```

### Product questions → filter `outcome="ok"`, usually scope `class="resolution"`

```promql
# Successful resolution-class calls per minute — the number #43 exists to
# produce, e.g. for a photo-share panel (photo / (photo + text + voice)).
sum by (call_type) (rate(kora_ai_calls_total{outcome="ok", class="resolution"}[5m]))
```

Leave `class` unscoped only when the question is genuinely about total
successful volume across both resolution and derived calls (e.g. "AI calls
per second, all types") — most product questions (photo share, resolution
success rate) are about `class="resolution"` specifically, since `derived`
scales with meal complexity and corrections, not with user actions.

Before trusting an `outcome="ok"` panel for `coach`, `decompose`, or `embed`,
read the Help text on `kora_ai_calls_total` (`kubectl exec` into the pod, hit
`/metrics`, or `promtool metric-metadata`): those three call types record
**only** successful calls at the metering seam today, so their `error` /
`timeout` series will show near-zero not because they never fail, but because
the failure was never recorded. A 100% success rate there is an artefact of
that gap, not a fact about reliability — the same trap the "Two traps"
section above warns about for pre-#81 SQL rows.

### Per-user questions → NOT answerable from this exporter, by design

There is deliberately **no `user_id` label** anywhere in this exporter. Adding
one would make cardinality scale with the user base — every label
combination becomes its own time series, retained and billed by GCP Managed
Prometheus regardless of whether anyone ever queries it. "Median calls per
user" and "AI calls for user X" are not degraded or approximate here; they
are simply not derivable from any PromQL query over these series, full stop.

`ai_usage_events` stays the authoritative source for both **pricing** (#41,
which bills per user) and any **per-user rollup** (median calls per user,
etc.) — see the SQL rules above. The exporter and the table answer different
questions; neither substitutes for the other.

### Counters reset on pod restart → rates and trends, not historical totals

`kora_ai_calls_total` and `kora_ai_cost_usd_total` are Prometheus counters
backed by an in-memory registry (`internal/metrics/metrics.go`), not a
database. A pod restart — a deploy, an OOM kill, a Knative scale-to-zero —
resets every series to 0. Everything accrued between the last scrape before
that restart and the restart itself is gone; it was never durable.

- `rate()` / `increase()` over these counters handle a reset correctly
  (PromQL detects the counter going backwards and adjusts), so dashboards and
  alerts built on them are safe.
- A raw `sum(kora_ai_cost_usd_total)` is **not** "total spend ever" — it's
  "total spend since whichever series' pod last restarted," which silently
  under-counts after any redeploy. For an exact historical total (this
  month's actual spend, a bill reconciliation), query `ai_usage_events`
  directly — its rows are durable and don't reset.
