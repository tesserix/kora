# Resolution outcomes

Every food-resolution attempt now leaves a row, so "does the resolver work" is
a number rather than a feeling. Issue #459.

## Why this exists

The resolver already drew the distinctions that matter. `internal/ai`'s
`resolve()` logs three separate lines — *returning low-confidence match*,
*abstaining — best match below the floor*, and *no match and nothing to
decompose* — with a comment explaining why they must never be conflated:

> the two demand opposite responses: a floor that is too high is fixed by
> lowering it, an index gap only by adding data. On 2026-08-16 a device test of
> "McSpicy" correctly showed "couldn't identify that", and nothing in the logs
> could say which of the two had produced it.

A log line cannot be counted, queried or triaged. This is those lines, kept.

**The taxonomy is not invented here.** Each `kind` maps to a branch that
already existed, so a row can be traced back to the line that produced it.

## Every attempt, not every failure

Recording only failures makes the failure *count* available and the failure
*rate* uncomputable. The denominator is attempts, and a successful resolve
leaves no other trace — a cache hit never reaches the provider, so
`ai_usage_events` cannot supply it either.

#328's "resolution correct on first try for ≥90% of logs" needs both halves.
At Kora's scale (a 10–15 tester beta) a row per resolve is a few thousand a
month.

## The kinds

| kind | what happened | fix |
|---|---|---|
| `cache` | served from the resolution cache | — |
| `alias` | personal-alias short-circuit: a **previous correction paying off** | — |
| `resolved` | matched at auto or confirm tier | — |
| `weak_match` | low-confidence match returned rather than decomposed (#180) | watch |
| `below_floor` | candidates existed, all under `minReturnableMatchScore` — the index **has** near-misses | lower the floor |
| `no_match` | no candidate and nothing to decompose — an index **gap** | add data |
| `decomposed` | estimated by summing ingredients; that estimate is unscaled and can be an order of magnitude high | watch |
| `budget` | the user's AI budget was exhausted before any call | — |
| `error` | the provider call failed | — |
| `transcript_blank` | a voice capture transcribed to nothing — a **capture** failure | — |

`tier` stores the resolver's **own** `ai.Tier`, never a threshold re-derived
here. `ai.TierFor` owns that decision and this column must not become a second
opinion about it.

**`Kind.NeedsHuman()` is the only definition of triage work**, and it admits
exactly `below_floor` and `no_match`. The inbox queue, the health backlog depth
and the rate all read that one predicate, so they cannot disagree about what
counts. A weak match is a soft signal and a decomposition is a known-imprecise
answer; putting either in the queue would bury the two that are actionable.

## Recording must never break a resolve

`Repository.Record` returns **no error**, and the `ai.OutcomeSink` interface
makes that a compile-time property rather than a convention. The posture is
copied from `ai.Resolver.record`, which discards `billing.Meter.Record`'s error
for the same reason: the row is worth having and never worth failing a meal log
over.

Synchronous rather than fire-and-forget, also copying that precedent. A
goroutine would need its own context — the request's is cancelled the moment
the response is written, so the insert would race the response and usually lose
— and would drop rows silently on shutdown.

An unrecognised `kind` or `mode` is dropped with a log rather than written. The
CHECK constraints would reject it anyway, and a constraint violation surfacing
*inside* a resolve is exactly the failure this is built to prevent.

## Where it is wired

- **text / photo / voice** — inside `ai.Resolver`, which owns those branches.
  `Resolver.WithOutcomeSink` is optional and nil-safe, so a resolver built
  without one resolves exactly as before.
- **barcode** — in `resolve.Handler`, because `ResolveBarcode` never reaches
  the resolver. A barcode miss is the **cleanest failure signal in the
  product**: the barcode identifies exactly one product, so it is unambiguously
  "this food is missing" rather than "the matcher was unsure".

### Two things that were easy to get wrong

**Voice must be recorded as voice.** `ResolveVoice` delegates to the text
pipeline, so without threading the mode every transcript would be filed under
`text` and the voice path would be invisible in its own table. That is what
`resolveTextAs` exists for.

**Voice has its own budget gate**, ahead of the text pipeline's. Without a
recorder there, an attempt refused for budget would leave no row at all and the
voice denominator would silently exclude exactly the users who hit their cap.

## First-try rate

`Rates.FirstTryRate()` divides `resolved` by attempts **excluding cache and
alias hits**.

Excluding aliases is the point: an alias hit is a phrase the resolver got wrong
once already and a human fixed. Counting it as a first-try success would let the
correction loop improve the very metric that measures whether corrections are
still needed. A cache hit did not exercise the resolver at all.

It returns `ok=false` over an empty denominator. A rate over no attempts is not
0%, and rendering it as one is how an empty window comes to look like a total
failure.

## What this unblocks

- **`GET /admin/inbox` (#432)** — the second queue the issue asked for and
  could not have. Items carry the phrase as the title (it is what to fix), and
  the subtitle says which kind of failure and how close the index got. An index
  gap is `high` severity; a near-miss is `normal`.
- **`GET /admin/health` (#434)** — `unresolved_food_backlog` moves from
  `not_instrumented` to a genuine depth. Probes now return metrics, and a
  failing probe's numbers are **discarded**: a count from a check that errored
  is not a measurement.
- **`GET /admin/kpis` (#435)** — still a deliberate 501. One candidate metric
  is now computable, but #43 decides which numbers are headline; shipping one
  because it happened to become available is how a dashboard ends up rendering
  whatever was convenient to query.
- **The correction floor** — `docs/runbooks/kora-product-metrics.sql` query 7
  reports a *floor* on the correction rate, because `food_aliases` is an upsert
  and undercounts. This table supersedes that with a true rate.

## Accuracy scores (#556)

Each row keeps its trace id and the candidate food ids in order. A resolve
response carries the row id as `resolution_id`; the app sends it back with
`resolution_index`, the slot of the item a log keeps. Candidates are the items on
one plate, not alternatives, so every item is scored on its own.

`internal/accuracy` posts to Langfuse on the resolve's trace:

- `capture.top1_correct` — the logged food is the one offered in that slot.
- `capture.tier_correct` — the same check, sent only for `auto` tiers.

Score ids are `<resolution>-<slot>-<name>`, so changing the food on a later edit
overwrites the score, marked `corrected`, and `metadata.food_item_id` is the
label. A log only links to a resolution the user owns that has that slot;
anything else is logged without one. Scoring needs `KORA_LANGFUSE_HOST`,
`KORA_LANGFUSE_PUBLIC_KEY` and `KORA_LANGFUSE_SECRET_KEY`; without them logs
still link and nothing is sent.

## Privacy

`phrase` holds what the user said — the same category as
`food_logs.input_phrase`, so no new surface, and it is the whole point: without
it a failure row says something failed and nothing about what to fix.

The table cascades on account deletion and is in the data export.
`TestEveryUserScopedTableIsExportedOrExcluded` failed by name the moment the
table existed, which is that mechanism working.
