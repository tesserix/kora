# Design — make match_score discriminate (food-match scoring)

**Date:** 2026-08-02
**Follows:** [#21](https://github.com/tesserix/kora/issues/21) / [#71](https://github.com/tesserix/kora/pull/71) per-item confidence tiers · [#72](https://github.com/tesserix/kora/pull/72) food index + embeddings
**Milestone:** R1

## Problem

The confidence-tier system is correct, tested, deployed, and completely inert.
Every resolve in prod returns `match_tier: full_text`, `match_score` 0.717–0.726,
`tier: confirm`. Nothing reaches `follow_up`, so #71's per-item uncertain-row UI
can never appear to a real user.

The cause is not coverage and not the thresholds. **`match_score` is a constant.**

`ts_rank` with the default normalization flag (`0`) ignores document length
entirely, and `plainto_tsquery` ANDs every term — so every row surviving the
`@@` filter matched *all* query terms. The rank therefore depends only on how
many terms the query had, not on how well any candidate matched:

| doc matched against query | ts_rank | match_score |
|---|---|---|
| `oat` ← "oat" | 0.0607927 | 0.71662 |
| `fast food fried chicken breast wing thigh drumstick` ← "chicken" | 0.0607927 | 0.71662 |
| `chicken breast` ← "chicken breast" | 0.0991032 | 0.72615 |
| `fast food fried chicken breast wing thigh drumstick nugget patty` ← "chicken breast" | 0.0991032 | 0.72615 |

The observed 0.717–0.726 band is exactly these two constants: 0.71662 = one
query term, 0.72615 = two. It is not a distribution.

Measured against the real prod failure case, every candidate ties:

| candidate | ts_rank | trigram | token precision |
|---|---|---|---|
| `chicken breast` | **0.09910** | 1.000 | 1.000 |
| `chicken breast roasted` | **0.09910** | 0.682 | 0.667 |
| `grilled chicken breast` | **0.09910** | 0.652 | 0.667 |
| `fast food fried chicken breast` | **0.09910** | 0.556 | 0.400 |
| `fast food fried chicken breast wing thigh drumstick nugget` | **0.09910** | 0.278 | 0.222 |

### Three consequences — the two "separate" open problems are one bug

1. `match_score` is constant per query → `TierFor` always returns `confirm`.
   **Retuning the 0.90/0.70 floors cannot work**: that re-labels a constant
   rather than separating a distribution.
2. `ORDER BY rank DESC` over a total tie is arbitrary Postgres order, so
   `cands[0]` (`resolver.go:361`) is a coin flip. **This — not SR Legacy's
   clinical near-duplicates — is why "chicken breast" resolves to "Fast Foods,
   Fried Chicken, Breast."** The near-duplicates only supplied more tied rows to
   lose to; a separate display-vs-search name would not have fixed it.
3. The embedding tier is *not* conditional in the code. The pgvector query runs
   whenever `queryVec != nil` (`repository.go:193`); its rows simply append
   after full-text in `out` and are cut by `out[:limit]`. The embedding scan is
   already paid for on every resolve and the result discarded.

This supersedes the prior reading in `docs/superpowers/HANDOFF-2026-08-02-food-index.md`,
which framed direction (2) — retuning the floors — as viable. It is not.

## What already works

Not in scope — here so nobody rebuilds it:

- Tier constants, `TierFor`, per-item `Tier` on `ResolvedCandidate` — `api/internal/ai/types.go`
- Per-item uncertain-row UI: `help-circle` glyph, "Not sure which — tap to confirm",
  suppressed macros, excluded from kcal totals and from the add-to-diary batch —
  `apps/mobile/src/components/capture/DetectedCard.tsx`, `src/lib/candidateTier.ts`
- Uncertain row taps through to `FoodPicker` and promotes the row — `app/capture.tsx:991`
- Alias tier, personal-before-global precedence, deterministic global ordering — `repository.go:126–161`
- The 7,856-row index and `cmd/ingest`; `api/data/food/usda_sr_legacy.json` is committed

**The per-item loop is already complete.** Once scores discriminate, tiers fire
and the existing UI activates with no client change.

## Scope

Scoring, ordering, and floors inside `nutrition.Resolve`, plus the calibration
and tests that prove it. No signature change, no wire-format change, no client
change.

Explicitly **excluded** by decision:

- Exposing runner-up candidates over the wire (see Decisions)
- Fixing the resolution-level `follow_up` dead-end in `capture.tsx`
- `cmd/embed`'s quota bug — a recall improvement, not a prerequisite (see Decisions)
- A separate display-vs-search name for clinical USDA names — the ranking fix
  addresses the symptom it was proposed for

## Decisions

| Question | Decision | Why |
|---|---|---|
| What does `match_score` mean? | Confidence in the top pick — falls on poor fit **and** on near-ties | Ambiguity is the common real case; "chicken breast" with five plausible rows should ask, not guess |
| Does the score depend on embeddings? | No. Lexical primary; embedding is an additive booster that is a no-op when `NULL` | Only 302/7,856 prod rows are embedded. A blended score would swing on whether a row happens to have one. Works on 100% of rows today, zero API cost, testable with no Gemini key |
| Change recall? | No. `@@ plainto_tsquery` and the pgvector query are untouched | Keeps the blast radius to "which item wins and how confident we say we are" |
| Retune the 0.90/0.70 floors instead? | Rejected | A constant cannot be re-thresholded into a distribution |
| Tune the weights against the golden set? | No — weights fixed by principle; only the two floors calibrated | Seven free parameters against a golden set of realistic size is overfitting dressed as rigour |
| Expose runner-up candidates? | Out of scope | The per-item path already has a working loop via `FoodPicker`. A wire change plus new client UI is the larger half of the work and is not the scoring bug |
| Fix `cmd/embed` first? | No | It improves recall, not discrimination. The formula is a no-op on unembedded rows, so coverage can improve later without changing anything |
| Threshold location | Stay hardcoded Go consts | #21 deferred this for want of data; this work produces the data but a config surface still buys nothing |

## The score — `api/internal/nutrition/repository.go`

Over `Normalize()`d tokens of the query (`Q`) and candidate name (`D`):

```
coverage  = |Q∩D| / |Q|     how much of what the user said the row accounts for
precision = |Q∩D| / |D|     how much of the row the query explains
trgm      = similarity(normalized_name, query)

lexical   = 0.4·coverage + 0.3·precision + 0.3·trgm
quality   = max(lexical, 0.85 · emb_sim)          // emb term omitted when NULL

margin          = quality₁ − quality₂             // 0 when only one candidate
ambiguityFactor = clamp(0.6 + 2·margin, 0.6, 1.0)
match_score     = quality₁ · ambiguityFactor
```

**Fixed by principle, not tuned:** the three weights, the `0.85` embedding
factor, and the `0.6`/`2` ambiguity constants. **Calibrated:** only
`tierAutoFloor` and `tierConfirmFloor`.

Worked through the real case, which is the check that this shape does the job:

| query | top candidates | quality₁ | margin | match_score | tier |
|---|---|---|---|---|---|
| `chicken breast`, exact row present | `chicken breast` (1.000) vs `chicken breast roasted` (0.805) | 1.000 | 0.195 | 0.99 | `auto` |
| `chicken breast`, prod index (no exact row) | `chicken breast roasted` (0.805) vs `grilled chicken breast` (0.796) | 0.805 | 0.009 | **0.50** | **`follow_up`** |

The same phrase lands in different tiers depending on whether the index can
actually distinguish an answer — which is the behaviour #71 was built for and
has never once seen. Note this also suggests calibration may *confirm* the
existing 0.90/0.70 floors rather than move them; the floors were never the
problem, and the measurement should be allowed to say so.

`precision` is what demotes `fast food fried chicken breast wing thigh drumstick`
(0.222) below `chicken breast` (1.000).

`coverage` is always 1.0 *within* the full-text set, because `plainto_tsquery`
ANDs. It is not dead weight: it separates full-text candidates from
embedding-only ones, which share few or no query terms. **That is the mechanism
that makes a sub-0.70 score reachable**, and it is why embedding can be a real
signal without needing index-wide coverage.

`quality` is monotone in both inputs and a no-op when `embedding IS NULL`, so
the 302/7,856 gap cannot distort a score.

`ambiguityFactor` pulls the score down as top-1 and top-2 converge, so five
near-tied candidates land in `follow_up` even when the top row is a perfect
match.

### Two deletions that matter more than the additions

- **The `0.7 + 0.29·s` clamp goes.** It structurally guaranteed `≥ confirm`; no
  tier retuning survives it.
- **`out` is sorted by `match_score` across all tiers** instead of appended in
  tier order — so `out[:limit]` stops silently discarding embedding candidates
  and `cands[0]` stops being an arbitrary pick among ties.

Alias keeps `1.0` and still short-circuits: an exact user alias is exact intent
and should stay `auto`.

### Migration

`CREATE EXTENSION IF NOT EXISTS pg_trgm` plus a GIN trigram index on
`normalized_name`, following `000004_nutrition_index.up.sql`. Available at 1.6
in the local image; **confirm on the prod instance before relying on it** — a
green migration test says nothing about the live cluster.

## Calibration

**The golden set is written first, from the phrases, not the code** — committed
before the formula exists so weights cannot be reverse-fitted to it. ~40–60
`query → expected item + expected tier` rows in four deliberate bands:

- *unambiguous* — `paneer`, `dal tadka`, `biryani`, `lasagne` (the ones #72 verified) → `auto`/`confirm`
- *ambiguous by construction* — `chicken breast`, `rice`, `milk`: correct top row, several near-ties → **`follow_up`**. These prove the tier system fires
- *obscure/absent* — foods genuinely not in the index → `follow_up`
- *the regression case* — `chicken breast` ranks `chicken breast` above `fast foods fried chicken breast`

**A separate calibration database.** Loading the full index into the DB the Go
suite uses breaks the nutrition tests, which need a clean `food_items`.
Calibration ingests into its own database; the suite's DB is left alone.

**Floors come out of the measured distribution**, not the reverse: run the
golden set against the real index, find where correct-and-unambiguous separates
from ambiguous, set `tierAutoFloor` / `tierConfirmFloor` there. If no clean
separation exists, that is a finding about the formula and gets reported rather
than papered over with tidy-looking numbers.

## Testing

1. **Unit** — the scoring function over hand-built token sets. Pure, no DB.
2. **Golden-set accuracy** — top-1 correctness and per-case tier expectations
   against the real index.
3. **Non-degeneracy** — across the golden set, all three tiers occur and the
   score spread exceeds a floor. Plus a direct trap test: two candidates with
   *identical* `ts_rank` must receive *different* `match_score`s.

Test 3 is the one that did not exist, and its absence is exactly why a correct,
well-tested, deployed tier system sat inert.

**Mutation-proofing.** It is not enough that these fail when the code breaks —
each must fail *on the assertion it claims*. Verify by reverting to
`0.7 + 0.29·s` and confirming the non-degeneracy test fails on the tier-spread
assertion specifically, not on an incidental count. Same check for the tie test.

**Prod verification is the acceptance criterion, not the tests.** The tests can
all pass and the thing still be inert — that is what happened. After deploy,
resolve a set of real phrases against prod and show a `match_tier` /
`match_score` / `tier` distribution that is no longer a single band. Anything
short of that spread is not done.

## Risks accepted

- **Many queries will resolve to a different item than today.** That is the fix
  working, but it is a real behaviour change, and the golden set is the only
  thing standing between "better" and "differently wrong".
- **Resolution-level `follow_up` becomes reachable where it was not.**
  `capture.tsx:277–285` discards candidates in that branch and dead-ends at
  "Search manually", despite asking "Which of these best matches what you ate?".
  Defensible (we genuinely do not know), worse than the per-item path, out of
  scope to fix, in scope to watch.
- **pg_trgm on the prod instance is unconfirmed.** Verified before the migration
  is relied upon.
