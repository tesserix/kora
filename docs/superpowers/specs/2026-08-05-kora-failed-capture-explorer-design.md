# Design — Kora failed-capture explorer

Date: 2026-08-05. Touches `kora` (one admin endpoint, and — if the proposal
below is accepted — one migration) and `tesserix-home` (one page). Follows
`2026-08-05-kora-admin-surface-design.md` and depends on slice 1 of
`2026-08-05-kora-food-data-admin-design.md`.

**Status: scoped, NOT designed with the user.** Unlike the food-data and
AI-key designs, no decision in this document was made in conversation. It is
written from the verified facts of 2026-08-05 and from the failure history
below. Treat every "proposal" here as a proposal; the open questions at the end
are genuinely open.

## Purpose

Make failed AI calls visible at all.

This is the highest operational value item in the Kora admin backlog, and the
argument for it is not hypothetical. Three separate bugs shipped in sequence:

- **#82** — the client never sent the multipart body at all (React Native
  rejects the `{uri, name, type}` FormData part; an `as unknown as Blob` cast
  hid it from `tsc`).
- **#79** — Istio's 30s `perTryTimeout` killed the request before the router's
  own fallback budget could ever run.
- **#87** — a 3s vision budget paired with a text-only fallback model.

Every one of them presented to the operator as **the same detail-free 500**.
`httpx.RespondServiceError` collapses everything to
`{"error":"internal_error","message":"something went wrong"}`, and the AI layer
logs nothing on failure. Each bug therefore *hid the next one*: fixing #82
revealed #79, fixing #79 revealed #87. The path is completely dark, and the
cost of that darkness was three round trips of hand-debugging against prod.

A page that lists recent failures — even a shallow one — turns "photo capture
is broken again" into "twelve `identify_photo` calls timed out at 30,000ms in
the last hour", which is most of a diagnosis.

## What it shows

One row per non-`ok` row in `ai_usage_events`, newest first:

| Column | Source |
|---|---|
| Time | `created_at` |
| Call type | `call_type` (`identify_photo`, `identify_text`, `transcribe`, `coach`, `decompose`, `embed`) |
| Outcome | `outcome` — `error` or `timeout`, kept distinct |
| Model | `model`, with `provider` |
| Latency | `latency_ms` |
| Tokens | `tokens_in` / `tokens_out` |
| Est. cost | `cost_usd_est` |
| User | `user_id` (NOT NULL, so every failure is attributable) |

Filters: time window, `call_type`, `outcome`, `model`. Default window 24h.

Above the table, a count by `(call_type, outcome)` for the window — because the
shape of a failure burst ("all `identify_photo`, all `timeout`, all ~30,000ms")
is the diagnostic signal, not any single row.

`latency_ms` next to `outcome` is the single most useful pairing on the page.
#79 was a 500 at *exactly* 30,000ms every time; a column of near-identical
latencies clustered on a round number is an infrastructure timeout, not a
model failure, and that read is available at a glance.

## The honest limit: the page cannot show *why*

**`ai_usage_events` has no `error_message` and no `request_id` column.** The
schema is:

```
id, user_id uuid NOT NULL, provider text, model text, call_type text,
tokens_in int, tokens_out int, latency_ms int, cost_usd_est float8,
created_at timestamptz, outcome text NOT NULL DEFAULT 'ok'
```

So this page can show *that* a call failed, *which* call, *for whom*, *how
slowly*, and *how expensively*. It cannot show the provider's error, the HTTP
status, the exception, or anything that would let you correlate a row with a
log line. There is no id shared with the request that produced it.

Against the three bugs above, the shallow version would have helped
substantially with #79 (the latency signature is unmistakable), partially with
#87 (a `timeout` on a 3s budget looks different from a 30s one), and **not at
all with #82** — a request that never left the client produces no row anywhere.

### Proposal: add an error column

**Proposed, not decided:** add `error_class text NULL` and `error_detail text
NULL` to `ai_usage_events`, populated at the same metering seam that already
sets `outcome`.

- `error_class` is a small closed vocabulary (`context_deadline`,
  `provider_4xx`, `provider_5xx`, `parse_failure`, `quota_exhausted`, …) so it
  can be grouped and counted. This is the column that makes the page
  diagnostic rather than merely observant.
- `error_detail` is the truncated provider/transport message, for the one row
  you actually open.

The reason to state this as a proposal inside this spec rather than build the
page and add the column later: **the useful version of this page requires it.**
Building the shallow version first is defensible — it is nearly free once the
BFF exists, and the latency signature alone earns its keep — but it should be
built knowing it answers "something is wrong with photo capture" and not "here
is what went wrong".

Two things to get right if the column is added:

- **`error_detail` can contain user content.** A parse failure may quote the
  model's output, which may quote the user's phrase or describe their meal.
  Truncate, and decide deliberately whether it is retained (open question
  below).
- **It must never make metering fail.** The meter records events on a path that
  serves users; a write that errors because a message was too long for a column
  is a self-inflicted outage. Truncate before insert, in Go.

## The second blind spot: three call types record only successes

`coach`, `decompose` and `embed` record **only successful calls** at the
metering seam. Their failures are not `outcome='error'` rows — they are *no
rows at all*.

So this page will never show a `coach` failure, a `decompose` failure, or an
`embed` failure, however many there are. That is not a display bug and no
filter fixes it; it is a gap at the write seam. `embed` matters most of the
three: `cmd/embed` logging *"entire batch of 100 rows failed to embed;
stopping"* and exiting 0 is exactly the failure this page exists to surface,
and it is structurally invisible here.

The page must say so, on the page — a footnote listing which call types can
appear at all. An operator who reads "0 coach failures" as "coach is healthy"
has been misled by the surface, and `coach` has in fact **never recorded a
call in prod**, successful or otherwise.

## The empty state is a design problem, not a placeholder

As of the 2026-08-04 reading recorded in the Phase 1 design, `ai_usage_events`
had **zero `error` and zero `timeout` rows** across 124 events. This page may
well be empty on the day it ships.

An empty table must therefore distinguish three states that look identical:

1. No failures in the window. (Good.)
2. Failures occurred but the call type does not record them. (See above.)
3. The window predates 2026-08-04, when **every row was `outcome='ok'` by
   construction** — the migration's default. Failures before that date were
   never recorded at all.

State 3 is a hard boundary: a window that reaches back past 2026-08-04 will
report a 100% success rate that is an artefact, not a fact. The page should
refuse to imply otherwise — either clamp the earliest selectable window to that
date, or annotate it. `docs/ai-usage-queries.md` records this trap; it applies
verbatim here.

## Data source and access path

`ai_usage_events`, read through **kora-api's signed BFF** — slice 1 of the
food-data admin design.

**The portal has no database access to Kora.** It holds `MARK8LY_DB_*` and
`HOMECHEF_DB_*` credentials only, and the food-data design deliberately keeps
that true by routing everything over one HMAC-signed path rather than adding a
second. This page inherits that decision. It is a read-only `GET` over an
already-authenticated route; it adds no new access pattern.

This is not a Prometheus surface. `kora_ai_calls_total{class,call_type,model,
outcome}` can tell you *how many* calls failed, but it carries no `user_id` by
design and no per-row detail, so it cannot list failures. It is also currently
dark: **Managed Prometheus is not enabled on the cluster**
(`managedPrometheusConfig: {}`), so `PodMonitoring` resources report `Synced`
and are never scraped, and GMP holds zero `kora_*` descriptors. Any counter
panel on this page would render nothing until that changes.

### The query

`ai_usage_events` already carries a purpose-built partial index:

```
idx_ai_usage_events_outcome btree (outcome) WHERE outcome <> 'ok'
```

so the listing query is cheap regardless of how large the table grows:

```sql
SELECT created_at, call_type, outcome, provider, model,
       latency_ms, tokens_in, tokens_out, cost_usd_est, user_id
FROM ai_usage_events
WHERE outcome <> 'ok'
  AND created_at >= now() - $1::interval
ORDER BY created_at DESC
LIMIT $2;
```

Use `outcome <> 'ok'` rather than `outcome IN ('error','timeout')` — it matches
the index predicate exactly, and it keeps working if a third failure outcome is
ever added.

The summary counts are the reliability query from `docs/ai-usage-queries.md`,
grouped rather than filtered:

```sql
SELECT call_type, outcome, count(*)
FROM ai_usage_events
WHERE created_at >= now() - $1::interval
GROUP BY call_type, outcome
ORDER BY call_type, outcome;
```

Note this second query is deliberately **unfiltered** on outcome, because it is
answering "what is the failure rate", which needs the denominator.

## Dependencies

- **Slice 1 of the food-data admin design** (BFF auth, `KORA_BFF_HMAC_KEY`,
  `lib/api/kora-admin.ts`). Hard dependency; there is no other path to the data.
- **Phase 1 nav plumbing** (`ProductConfig`, the `kora` route group, the
  hand-written `koraNav` in `components/admin/sidebar.tsx`). Adding a product
  is *not* config-only, whatever `lib/products/types.ts:2-3` claims.
- **Nothing from Prometheus.** Deliberately.

## Out of scope

- **Any write.** No retry-this-call, no re-run, no dismiss. Read-only.
- **Alerting.** A gauge or an alert rule on failure rate is a better fit for
  the exporter than for a page, and it depends on GMP being enabled.
- **Log correlation.** Without a `request_id` there is nothing to correlate on.
  If one is ever added, this page is where the link belongs.
- **Fixing the write-seam gap for `coach` / `decompose` / `embed`.** Named here
  because it bounds what the page can show; fixing it is separate work.
- **Changing `httpx.RespondServiceError`.** The detail-free 500 is correct for
  a *client* response. This page is the operator-side answer to it.

## Open questions

1. **Shallow now, or wait for the error column?** Building the shallow version
   first gets the latency signature in front of an operator sooner; waiting
   avoids shipping a page whose main column is missing. Not decided.
2. **What exactly goes in `error_class`?** The vocabulary above is a sketch. It
   should be derived from the failure modes the AI layer can actually
   distinguish, which needs a read of the provider client error paths.
3. **Is `error_detail` retained, and for how long?** It can contain user meal
   descriptions. A retention window (or dropping the column entirely and
   keeping only `error_class`) is a privacy decision, not a technical one.
4. **Does the user column show an id, an email, or nothing?** See the
   user-visibility design, which faces the same question and should answer it
   once for both surfaces.
5. **Should failures be counted per *action* or per *row*?** One user tap can
   produce several rows when a fallback leg is abandoned, so "12 failures" may
   be six users' taps. Without a request id the page cannot group them, and
   should probably say "12 failed calls" rather than "12 failed captures".
6. **Retention on `ai_usage_events` generally.** 124 rows today; nobody has
   decided what happens at a million. Not urgent, but this page is the first
   thing that makes the table's size an operational concern.
