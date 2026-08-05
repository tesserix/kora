# Design — Kora per-user economics

Date: 2026-08-05. Touches `kora` (one admin endpoint) and `tesserix-home` (one
page). This is **Phase 4** of `2026-08-05-kora-admin-surface-design.md`, and it
depends on slice 1 of `2026-08-05-kora-food-data-admin-design.md`.

**Status: scoped, NOT designed with the user.** Unlike the food-data and
AI-key designs, nothing here was decided in conversation.

---

## Read this first: build this last

**With 6 users, 3 food logs and 124 AI usage events, every number on this page
is noise.** That is not a hedge — #43's own analysis says so, and the Phase 1
design says the same about Phase 4. A median over six users, two of whom have
ever logged anything, is not an estimate with wide error bars; it is a
different number every time someone signs up.

This page should be built **after** the failed-capture explorer, user
visibility and resolution quality, for two reasons:

- Those three surfaces make the product work. This one prices a product that
  four of six users have not yet activated on, and the activation problem is
  strictly upstream of the pricing problem.
- Their instrumentation improves this page's inputs. Resolution quality tells
  you how often a resolve is retried or abandoned, which is exactly the ratio
  that turns "calls per user" into "cost per user action".

Build it when there is enough traffic that a median means something. Specify it
now so the queries are right when that day comes, because **the filtering rules
below have already been got wrong twice.**

---

## Purpose

Produce the numbers that gate **#41 (pricing)**:

- Median AI calls per active user, per month.
- Photo share of captures — photo is the expensive path by an order of
  magnitude (the observed `identify_photo` average is ~12.8s and ~13.4s max,
  against ~0.9s for `identify_text`).
- Σ estimated AI cost per user.
- Margin at candidate price points.

## The filtering rule, which is not intuitive

From `docs/ai-usage-queries.md`, which must be read before writing any query on
this page:

**Resource questions count every row.** *"What did we actually spend?"* /
*"How much free-tier quota is left?"* Failed calls still cost money and still
consume quota — providers return token usage alongside an error, and a request
that reached the provider is billed whether or not our client waited for the
answer. `billing.Meter.WithinBudget` follows this rule and two tests fail if
anyone "fixes" it to filter.

```sql
-- True spend this month. No outcome filter: failures cost money too.
SELECT COALESCE(SUM(cost_usd_est), 0) AS spend_usd
FROM ai_usage_events
WHERE created_at >= date_trunc('month', now());
```

**Product questions filter `outcome = 'ok'`.** *"Calls per active user"* /
*"photo share"* / anything feeding pricing. Without the filter, failures and
retries inflate the number.

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

**Both appear on this page**, which is exactly why it is dangerous. "Cost per
user" is a resource question in its numerator and a product question in its
denominator, and the page must be explicit per panel about which rule it used.
Label the panels, not just this document.

## The two traps, which apply here directly

**Trap 1 — the 2026-08-04 boundary.** Every row before that date is
`outcome = 'ok'` **by construction**: `outcome` was added with a default, and
before #81 the table recorded a provider call *only when it succeeded*. So any
reliability or success-rate query spanning that boundary reports a **fake 100%
success rate**. It is an artefact of the migration, not a fact about the
system. Any panel here that divides successes by attempts must either start its
window at 2026-08-04 or annotate the boundary.

The corollary is just as important: **zero rows never meant "unused" before
#81.** A never-working path and a never-attempted path were indistinguishable
— which is how `identify_photo` and `transcribe` sat at zero for the life of
the project while genuinely broken.

**Trap 2 — one user action can be several rows.** A resolve whose primary leg
is abandoned records both legs. Per-user *call* counts are therefore **not**
per-user *action* counts, and the ratio between them depends on how often the
fast path misses its budget. A pricing model built on "calls per user" while
thinking in "captures per user" over-states usage by whatever that ratio
happens to be, and the ratio is not currently measured.

`decompose` runs at **1,422 ms against a 1,500 ms `textBudget`** — 5% headroom
— so the abandoned-leg rate is not a theoretical concern. It is one slow call
away from being the common case.

## The third trap, specific to cost: `cmd/embed` records nothing

**`cmd/embed` discards the `Usage` it receives entirely**, so the food index's
embedding spend appears in neither `ai_usage_events` nor
`kora_ai_cost_usd_total`.

The consequence is blunt: **"total COGS = resolution + derived" is false at the
org level.** There is a real, ongoing cost — clearing the current embedding
backlog is a four-to-five day process against Gemini's 1,000/day free-tier cap
— that this page cannot see and will not see until that is fixed (#97). The
food-data admin design routes its *new* embedding worker through
`billing.Meter` so this stops being true for work that worker performs, and
explicitly leaves the existing `cmd/embed` alone.

The page must state this as a footnote on any total. A per-*user* number is
unaffected — index embedding is not attributable to a user, and that is
precisely why it goes missing.

## What class of calls counts as "usage"?

The taxonomy from `docs/ai-usage-queries.md`:

- `class = resolution` — `identify_photo`, `identify_text`, `transcribe`,
  `coach`
- `class = derived` — `decompose`, `embed`

This choice moves the headline number more than anything else on the page. From
the per-call-type reading recorded in the Phase 1 design (2026-08-04):
`embed` 77, `identify_text` 30, `decompose` 15, `identify_photo` 2. **Derived
calls are 92 of 124 — roughly three-quarters of everything recorded.** Scoping
"calls per user" to `class = resolution` versus leaving it unscoped changes the
figure by about four-fold at that mix.

`derived` scales with meal complexity and with corrections, not with user
actions, so most product questions want `class = resolution`. But `derived`
still costs money, so cost questions want both. **Decide per panel and say
which.** Do not let one number quietly serve both purposes.

## What the page shows

Per month, with a user cohort selector if one is ever needed:

- **Active users** — definition required, see open questions.
- **Median / p90 successful AI calls per active user** (`outcome = 'ok'`,
  scoped to `class = resolution`).
- **Photo share** — `identify_photo` as a share of successful resolution-class
  calls. The cost driver.
- **Σ estimated cost, and cost per active user** — unfiltered on outcome, with
  the `cmd/embed` footnote.
- **Cost distribution across users** — a heavy tail is the entire pricing risk.
  A median tells you nothing about the user who costs 30× it.
- **Margin at candidate prices** — a small table: candidate monthly price ×
  observed cost per active user. **No candidate prices exist yet**; choosing
  them is #41's job, not this design's, and inventing them here would put fake
  numbers in a spec.

### `cost_usd_est` is an estimate

The column name says so. It is computed from token counts and a price table in
Kora, not read from a provider invoice. It is fit for "is this user 10× the
median" and unfit for "reconcile the bill". Any panel presenting it as money
should say "est." on the page.

## Data source and access path

`ai_usage_events` and `food_logs`, read through **kora-api's signed BFF** —
slice 1 of the food-data admin design. **The portal has no database access to
Kora**, and that design deliberately refuses to build a second access path.

**Prometheus cannot answer any of this, by design.** There is deliberately **no
`user_id` label anywhere in the exporter**; adding one would make cardinality
scale with the user base, and every combination becomes a series retained and
billed by GCP Managed Prometheus whether or not anyone queries it. "Median
calls per user" is not approximate or degraded there — it is not derivable from
any PromQL query over these series, full stop. `ai_usage_events` is and stays
authoritative for pricing.

Two further reasons not to reach for PromQL here even for the aggregates:

- **Counters reset on pod restart.** `kora_ai_cost_usd_total` is backed by an
  in-memory registry, so a deploy, an OOM kill or a scale-to-zero resets every
  series. `rate()`/`increase()` handle that correctly; a raw `sum()` is "spend
  since whichever pod last restarted" and silently under-counts. For an exact
  monthly total, query the table — its rows are durable.
- **Managed Prometheus is not enabled on the cluster**
  (`managedPrometheusConfig: {}`), so `PodMonitoring` resources report `Synced`
  and are never scraped, and GMP holds zero `kora_*` descriptors. The portal's
  `PROMETHEUS_URL` also points at `prometheus-server.monitoring`, a Service
  with zero endpoints. Every Prometheus panel in the portal renders "—" for
  every product today — which means the **infrastructure** half of unit
  economics (the OpenCost/Prometheus figures the existing
  `ProductOverviewLayout` supplies via `costAttribution`) is dark too. Full
  unit economics needs both halves; this design supplies one of them.

## Dependencies

- **Slice 1 of the food-data admin design.** Hard.
- **Phase 1 nav plumbing** — `ProductConfig`, the `kora` route group, the
  hand-written `koraNav`. Note that if any figure here is surfaced as an
  Overview tile, `resolveKpiValue` looks tiles up **by key** and renders "—" on
  a mismatch with no error anywhere — a typo'd key is indistinguishable from a
  missing number.
- **Enough traffic for a median to mean anything.** The real dependency.
- Optional but valuable: the resolution-quality instrumentation, which supplies
  the calls-per-*action* ratio that trap 2 leaves unmeasured.

## Out of scope

- **Setting prices.** That is #41. This page produces the inputs.
- **Billing, subscriptions, payment.** Kora has none, and the Phase 1
  `ProductConfig` deliberately omits `pricingByPlan` so the portal's billing
  section auto-hides.
- **Showing a user their own cost.** Operator surface only.
- **Fixing `cmd/embed`'s missing usage accounting.** Named because it bounds
  what the totals mean; the fix belongs with #97 and with the food-data
  design's embedding worker.
- **Per-user infra cost attribution.** OpenCost attributes at the namespace
  level; splitting a Deployment's cost across six users would be a modelling
  exercise producing a number nobody should trust.
- **Forecasting.** Extrapolating from three food logs is not forecasting.

## Open questions

1. **What is an "active user"?** "Logged ≥1 meal this month" and "made ≥1
   successful AI call this month" give different denominators, and cost per
   active user is entirely a function of which is chosen. The user-visibility
   design faces the same question; answer it once.
2. **Scoped to `class = resolution`, or all calls?** Argued above; changes the
   headline roughly four-fold at the observed mix. Probably resolution-scoped
   for usage panels and unscoped for cost panels — but that means two different
   denominators on one page, which needs to be visibly labelled or it will
   mislead.
3. **What are the candidate price points?** None decided. Without them the
   margin table has no columns.
4. **Is `cmd/embed`'s spend estimated in the meantime?** It could be
   approximated from `food_items` embedded-count deltas and a per-embedding
   price, which is better than showing nothing and worse than measuring. Or the
   page could simply state the total excludes it. Not decided.
5. **What window?** Calendar month matches how providers bill and how a
   subscription would price; rolling 30 days is more stable. They disagree most
   in the first week of a month, which is when someone will look.
6. **Does this need `ai_usage_events` retention or rollups?** 124 rows today.
   A monthly rollup table would make these queries trivial and add a
   correctness surface of its own. Premature now; worth deciding before the
   table is large.
