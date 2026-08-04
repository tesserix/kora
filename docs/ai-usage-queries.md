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
```

Taxonomy already decided: `class=resolution` for
`identify_photo|identify_text|transcribe|coach`, `class=derived` for
`decompose|embed`. Total COGS is the sum across both.
