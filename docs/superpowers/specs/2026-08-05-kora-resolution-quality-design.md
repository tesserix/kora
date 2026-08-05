# Design — Kora resolution quality

Date: 2026-08-05. Touches `kora` (instrumentation — a migration and a write on
the resolve path — plus one admin endpoint) and `tesserix-home` (one page).
Follows `2026-08-05-kora-admin-surface-design.md` and depends on slice 1 of
`2026-08-05-kora-food-data-admin-design.md`.

**Status: scoped, NOT designed with the user.** Unlike the food-data and
AI-key designs, nothing here was decided in conversation. This one has more
open questions than the others because it has more genuine choices in it.

---

## Read this first: there is nothing to query

**The data does not exist. This spec cannot be a page over existing rows; it
has to add instrumentation first, and there will be zero historical data until
that ships.**

`food_logs` is:

```
id, user_id, food_item_id uuid NULL, logged_at, meal_slot, source,
description, quantity_grams, kcal, protein_g, carbs_g, fat_g, fiber_g,
provenance NOT NULL, client_log_ms int NULL, created_at, input_phrase text NULL
```

There is **no `match_tier` and no `match_score`**. `provenance` and `source`
exist and answer different questions ("where did the numbers come from",
"which capture path was used"). Resolution *quality* — how confident the
engine was, which retrieval tier won, whether the top pick was clearly ahead of
the runner-up — is **not answerable from stored data at all**.

Two further facts sharpen this:

- `foodlog.LogRequest` (the create-log request body) carries `food_item_id`,
  `description`, `meal_slot`, `source`, `quantity_grams`, `logged_at`,
  `client_log_ms`, `input_phrase` and an optional client-minted `id`. **It has
  no score or tier field either.** So "just add two columns to `food_logs`" is
  not a migration — it is a migration *plus a mobile release*, because the
  server does not have the values at log time.
- Even the columns that do exist are not trustworthy backwards.
  `food_logs.source` used to record the **open capture tab**, not the
  resolution that actually ran. Fixed in #80 (merged 9e16b45); rows written
  before that are mislabelled.

So: whatever is built, the page's first honest sentence is *"since
&lt;deploy date&gt;"*, and it can say nothing about the resolutions that have
already happened. That is unavoidable and should be stated on the page, not
just in this document.

---

## Purpose

Answer, continuously and in prod, the questions the #73 scoring work could only
answer once by hand:

1. **Do the tiers fire?** Before #73, every prod resolve returned
   `match_tier: full_text`, `match_score` in a 0.717–0.726 band, `tier:
   confirm`. Not a distribution — two constants, because `ts_rank` with the
   default normalisation measures query length, not match quality. #73 replaced
   the score and stated plainly: *"Prod verification is the acceptance
   criterion, not the tests. The tests can all pass and the thing still be
   inert — that is what happened."* There is currently **no standing way to
   check that**, only a one-off manual probe.
2. **Does the embedding path work at all?** **`match_tier: embedding` has never
   been observed in prod.** The pgvector scan runs on every resolve where a
   query vector exists, and before #73 its rows were appended after full-text
   and silently cut by `out[:limit]`. #73 sorts across tiers so embedding
   candidates can now win. Whether any ever does is unknown, and roughly half
   the index (3,824 of 7,898 rows embedded, moving as the seed job runs) is
   eligible to be found that way. If the answer is "never", that is a finding
   about a subsystem the food-data design is spending four-to-five days of
   quota to fill.
3. **Which phrases the index cannot answer.** A phrase that lands in
   `follow_up` is a hole in the food index, and the food-data admin surface is
   where you fill it — add the food, add an alias. Without this, the two
   surfaces are disconnected: one lets you edit the index, the other would tell
   you *what to edit*.
4. **Whether the floors are right.** `tierAutoFloor` (0.90) and
   `tierConfirmFloor` (0.70) are hardcoded Go consts; #73 kept them there
   deliberately and calibrated them against a golden set. Prod distribution is
   the evidence that would justify moving them — or, as #73 anticipated,
   confirm them.

## The subtlety that decides what gets recorded

`ai.TierFor(identifyConf, matchScore)` takes **the limiting one of two
signals**: the LLM's identify confidence and the top candidate's match score.
So a `follow_up` resolution means *either* "the model wasn't sure what it was
looking at" *or* "the index couldn't distinguish an answer", and the tier alone
cannot tell you which.

**Record both inputs separately, not just the tier.** A page that shows only
tiers will send someone to fix the food index when the vision model was the
problem, or vice versa. This is the single most important thing to get right in
the instrumentation, and it is invisible unless you read `ai/types.go`.

Similarly, `Resolution.Tier` is the **max across items** — it answers "is
anything loggable?" — while each `ResolvedCandidate` carries its own `Tier`.
A meal where one item is confident and one is a guess reports as confident at
the resolution level. Per-item detail is where the interesting failures are.

## The options

### A. Persist `match_tier` + `match_score` on `food_logs` at write time

Two nullable columns; the client sends them with the log.

- **Cheapest to reason about.** The row already exists; the values sit
  alongside the food they describe; no new table.
- **Requires a mobile release**, because `LogRequest` has no such fields. The
  offline queue (#22) replays payloads minted by whatever app version was
  installed, so the columns must stay nullable indefinitely and old-shaped
  writes must keep working.
- **Fatally biased for the primary question.** `food_logs` only ever sees
  resolutions the user *accepted*. A `follow_up` the user abandoned, a wrong
  top pick they corrected away from, a capture they gave up on — none produce a
  row. The population this page most needs is exactly the population this
  option cannot see. Measuring resolution quality from accepted logs is
  measuring it after survivorship.

### B. Persist a resolution event server-side, at resolve time

A new table — call it `resolve_events` — written by the resolve path.

Per resolution: `created_at`, `user_id`, the resolve kind (text / photo /
voice / barcode), `identify_confidence`, resolution `tier`, candidate count,
and per top candidate: `match_tier`, `match_score`, `food_item_id`, item
`Tier`, and the top-1 vs top-2 quality margin (`ambiguityFactor`'s input, and
the thing that separates "bad match" from "several good matches").

- **No client change.** The server already holds every one of these values at
  the moment it builds the `Resolution`.
- **Sees everything**, including resolutions nobody logged — which is the
  cohort that matters.
- **Costs a write on a user-facing path.** It must be non-blocking and
  failure-tolerant: a resolution-quality insert that errors must never fail a
  capture. Same rule the Phase 1 gauge refresher follows, and the same rule
  `cmd/api/main.go` already applies to the metrics listener.
- **Carries user content** if the query phrase is stored — and the phrase is
  most of the value for question 3. See the privacy note below.
- **Cannot tell you whether the resolution was logged**, unless the client
  echoes a resolution id back on the log — which reintroduces the client change
  from option A. Without it the page can show *what the engine did* but not
  *what the user did with it*.

### C. A Prometheus histogram of match scores

Extend the #93 exporter: a `kora_match_score` histogram plus a counter by
`tier` and `match_tier`.

- **Cheapest of all**, and it fits an exporter that already exists and is
  deployed.
- **Can alert.** A gauge can page someone; a page only helps if a human
  happens to look. That argument is why Phase 1 chose the exporter over an HTTP
  endpoint, and it is not weaker here.
- **Cannot answer questions 3 or 4 at all.** "Which phrases land in
  `follow_up`" and "which foods lose to which" are per-food, per-phrase
  questions, and putting a food or a phrase in a Prometheus label is unbounded
  cardinality — the exact thing the exporter refuses to do with `user_id`, for
  the same billing reason. There is also **no `user_id` label by design, ever**.
- **Shows nothing today regardless.** Managed Prometheus is **not enabled on
  the cluster** (`managedPrometheusConfig: {}`), so `PodMonitoring` resources
  report `Synced` and are never scraped; GMP holds zero `kora_*` descriptors.
  And the portal's `PROMETHEUS_URL` points at `prometheus-server.monitoring`, a
  Service with **zero endpoints** — every Prometheus panel in the portal renders
  "—" for every product right now.

### Leaning

**B for the page, C alongside it, not A.**

B is the only option that sees the abandoned resolutions, and those are the
whole point. A's survivorship bias is not a limitation to note in a footnote —
it inverts the measurement.

C is worth doing *as well* because it is cheap, it aggregates cleanly, and it
is the only one of the three that can wake someone up. But it must not be
mistaken for the deliverable: it can tell you the tier mix moved and never tell
you which phrase moved it, and it will show nothing at all until GMP is
enabled. If only one thing is built, build B.

This is a leaning, not a decision. See open questions.

## What the page shows

Assuming option B, over a selectable window, and **labelled "since
&lt;instrumentation deploy date&gt;"**:

- **Tier mix over time** — `auto` / `confirm` / `follow_up` as a share of
  resolutions. The single number that says whether #73 worked. A flat 100%
  `confirm` means the score is a constant again.
- **Match-score distribution** — a histogram. #73's non-degeneracy test asserts
  a score spread exists in the test suite; this asserts it in prod, where the
  previous system was inert despite passing its tests.
- **Retrieval tier mix** — `alias` / `full_text` / `embedding`. **The row that
  answers whether embedding has ever won.** If it reads zero after a
  meaningful window, that is a bug report, not a statistic.
- **Confidence vs match score** — the two `TierFor` inputs, side by side, so
  "the model was unsure" is distinguishable from "the index was unsure".
- **Phrases landing in `follow_up`**, most frequent first, each linking to the
  food-index search in the food-data admin surface. This is the actionable
  panel: it turns a quality metric into a work queue.
- **Resolutions by kind** — text / photo / voice / barcode. Note `transcribe`
  has **never recorded a call in prod**, so voice is expected at zero until the
  multipart fix (#82) and timeout fix (#79) have been exercised by a real user.

## Data source and access path

`resolve_events` (new), read through **kora-api's signed BFF** — slice 1 of the
food-data admin design. **The portal has no database access to Kora**, and that
design deliberately refuses to build a second access path.

The instrumentation itself is a separate, larger dependency than the other Kora
admin surfaces have: this is the only one of the five that requires new writes
in `kora-api` before it can show anything.

## Privacy

If the query phrase is stored, `resolve_events` becomes a table of what people
said they ate, attributable to a user id. That is meal data — the same category
of information `food_logs` already holds, so it is not a new class of exposure,
but it is a new *copy* of it in a table created for operational purposes, and
it will contain phrases from captures the user abandoned and never saved.

Proposed: store the phrase, apply a **short retention window** (weeks, not
indefinite), and do not show it joined to an email on the page. The
user-visibility design's PII questions apply here and should be answered
consistently across both surfaces.

## Dependencies

- **New instrumentation in `kora-api`** — migration plus a non-blocking write
  on the resolve path. Nothing works without this, and nothing historical will
  ever be recoverable.
- **Slice 1 of the food-data admin design** for the read path.
- **Phase 1 nav plumbing.**
- **For the option-C panels only: Managed Prometheus enabled on the cluster.**
  It is not, today.

## Out of scope

- **Changing the scoring formula or the floors.** #73 fixed weights by
  principle and calibrated only the two floors; this surface produces evidence,
  it does not act on it.
- **A floors config surface in the portal.** #21 deferred it for want of data
  and #73 kept the consts hardcoded, noting a config surface "still buys
  nothing". Producing the data does not change that.
- **The golden set.** That is a test artefact against a separate calibration
  database, deliberately kept away from the Go suite's clean `food_items`. It
  is not a prod surface.
- **Correcting a bad resolution from the portal.** Users correct their own logs
  (#20); the food-data surface corrects the index. Neither belongs here.
- **Backfilling.** There is nothing to backfill from. Any attempt to infer
  historical quality from `provenance`/`source` would be inventing numbers —
  and `source` is mislabelled before #80 anyway.

## Open questions

1. **A, B, or C — or B+C?** The leaning above is argued, not agreed. B is the
   most work of the three and the only one that answers the primary question.
2. **Does the client echo a resolution id on the log?** It is the difference
   between "the engine was confident" and "the user accepted it", and
   acceptance rate is arguably the truest quality signal available. It costs a
   mobile release and a nullable column, and the offline queue means old
   payloads must keep working forever.
3. **One row per resolution, or one per candidate?** Per-candidate captures the
   per-item tiers where the interesting failures live; per-resolution is a
   fraction of the rows. At current volume the row count is irrelevant, so this
   is about query shape, not storage.
4. **Is the query phrase stored, and for how long?** See Privacy.
5. **Is anything sampled?** Not needed at 3 food logs and 124 AI events. The
   threshold at which it becomes needed is unknown and should be a documented
   trigger rather than a surprise.
6. **Does the exporter get the tier counter now?** It is cheap and it can
   alert — but it emits into a Prometheus that is not being scraped, so it
   would sit dark alongside every other `kora_*` series until GMP is enabled.
   Building metrics nobody can read has its own failure mode.
7. **How long a window before "embedding never wins" is a conclusion?** With
   current traffic, weeks. Deciding the threshold in advance stops it becoming
   an argument later.
