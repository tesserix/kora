# Design — per-item confidence tiers (#21)

**Date:** 2026-08-01
**Issue:** [#21](https://github.com/tesserix/kora/issues/21) — nutrition confidence tiers + portion error bars
**Milestone:** R0 – Daily driver (me)

## Problem

A resolve result implies precision it does not have. Today the confidence
signal reaching the user is a raw `73% match` line per item, and the tier that
gates logging is a single value for the whole resolution.

That aggregate is computed the wrong way round. `tierRank` scores
`auto`=3, `confirm`=2, `follow_up`=1 (`api/internal/ai/resolver.go:317`), and
the loop at `:375` keeps the **highest** rank. So a resolution reports the tier
of its *best* item. One confident match masks any number of bad ones, and
`:387` only raises a follow-up when *every* item is `follow_up`.

The per-item tier already exists: `resolver.go:374` computes
`TierFor(guess.Confidence, top.MatchScore)` for each guess and then discards it.

## What already works

Not in scope — this is here so nobody rebuilds it:

- Tier constants and thresholds (`auto` ≥0.90, `confirm` ≥0.70, else
  `follow_up`) — `api/internal/ai/types.go`
- `follow_up` blocks logging and renders a targeted question —
  `apps/mobile/app/capture.tsx:276`, `src/components/meal/AskAgainSheet.tsx`
- kcal ranges when `is_estimate` — `src/lib/resolutionKcal.ts`
- Per-candidate `match_score` / `match_tier`

## Scope

Per-item tiers plus an honest display. Explicitly **excluded** by decision:
per-item rationale text, and macro ranges (only kcal ranges exist and that
stays true).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Mixed confidence in one meal | Log the confident items; exclude and prompt on the uncertain one | One bad match must not hold an otherwise correct meal hostage — that is the friction users abandon over |
| Confidence display | Speak only when uncertain | Confident rows say nothing extra; the card is the claim. Matches "confidence through restraint"; the eye goes to the row that needs attention |
| Threshold location | Stay hardcoded Go consts | No data yet on whether 0.90/0.70 are right; a config surface never turned is cost without benefit |
| Resolving an uncertain item | Reuse the existing food-search sheet | The user resolves ambiguity by picking, not by reading model reasoning — which is why no rationale field is needed |

## Server — `api/internal/ai`

1. Add `Tier Tier \`json:"tier"\`` to `ResolvedCandidate` (`types.go`).
2. In `resolveGuesses`, stamp each candidate with the tier already computed at
   `resolver.go:374` rather than discarding it.
3. Stamp the other two construction paths: barcode candidates `TierAuto`
   (an exact barcode is an exact match, `resolver.go:152`), estimate candidates
   `TierConfirm` (`resolver.go:437`).

**`Resolution.Tier` is deliberately left unchanged.** It reads like a bug, but
under the new model it answers the right question — *is anything here
loggable?* — because max-rank means `follow_up` only when no item is. Per-item
tiers carry per-row treatment. Making it most-cautious would collapse the whole
card into a question screen whenever one item was weak, which is the opposite of
the mixed-confidence decision above.

## Client — `apps/mobile`

4. `ResolvedCandidate` in `src/api/types.ts` gains `tier: ResolveTier`.
5. `DetectedCard` renders `follow_up` rows — and only those — as uncertain:
   a marker, the line `Not sure which — tap to confirm`, no kcal figure,
   excluded from the add. `auto` and `confirm` rows are visually identical and
   loggable.

   **Why `confirm` gets no distinct treatment.** The issue describes the middle
   tier as "show + single confirm". That behaviour already exists universally:
   nothing in Kora logs without an explicit `Add to diary` tap, including `auto`
   results. So the card *is* the single confirm, and giving 70–90% an extra
   badge would decorate every ordinary result while telling the user nothing
   they can act on. The tier that changes behaviour is `follow_up`, and that is
   the one that speaks.
6. `kcalTotalLabel` (`src/lib/resolutionKcal.ts`) sums only loggable items, so
   the header total never counts something that will not be logged.
7. The CTA reflects the count: `Add 2 items to diary`.
8. Tapping an uncertain row opens the existing `FoodPicker` sheet; picking a
   food promotes the row to loggable and it joins the CTA count.

   **A promoted row shows no kcal until it is logged.** kcal is computed during
   resolve (`resolver.go:365`) from the matched row's `kcal_per_100g`; a
   freshly picked food has no server-computed kcal, and this codebase forbids
   the client computing nutrition (`DetectedCard` renders every number verbatim;
   the only sanctioned client math is summing kcal the server already supplied).
   So a promoted row renders `—` in place of kcal and is excluded from the
   header total while still counting toward the CTA. The true figure appears in
   the diary immediately after logging, server-computed. The alternative —
   `kcal_per_100g × grams / 100` in the client — is the same arithmetic the
   server does but breaks an invariant the codebase documents in several places,
   and was rejected for that reason.
9. All-items-uncertain needs no new work — the existing `follow_up` path already
   renders the question screen.

## Error handling

- A candidate arriving with no `tier` (an older server) is treated as loggable,
  preserving today's behaviour rather than silently excluding food.
- Promoting a row via the picker is local state only; nothing is written until
  the user taps the CTA.
- If every row is excluded, the CTA is disabled rather than logging an empty
  batch.

## Testing

**Go** — candidates carry a per-item tier on all three construction paths
(guesses, barcode, estimate); a mixed-confidence resolution stamps different
tiers on different candidates; `Resolution.Tier` aggregate behaviour is
unchanged.

**Mobile** — an uncertain row renders the prompt and no kcal; it is excluded
from `kcalTotalLabel` and from the CTA count; tapping it opens the picker;
picking promotes it into both; a candidate with no `tier` stays loggable.

Each test is written before its implementation and watched failing first —
including a mutation check that the exclusion assertions fail when exclusion is
removed. Green is not evidence until it has been seen red.

## Verification

Tests are necessary but not sufficient here. Every high-value defect in this
repo across the last four sessions was found by running the app, not by the
suite — a 401 dead-end, an Undo button rendering beneath its own sheet, an empty
food index, and an onboarding bounce that trapped every new user while 543 tests
passed. This change must be exercised in the app against a real resolve that
returns a sub-0.70 item before it is considered done.
