---
status: resolved
trigger: "Capture card: when Otto returns 2-3 weakly-matched items (per-ingredient tier follow_up from decomposeAndEstimate), every row renders \"Not sure which — tap to confirm\" with no kcal, is filtered out of loggableCandidates, and the CTA becomes a disabled \"Add 0 items to diary\" — the user cannot log at all. Root cause already identified: estimateIngredientTier (api/internal/ai/resolver.go:443) drops ingredients under the 0.70 match floor to TierFollowUp; isLoggable (apps/mobile/src/lib/candidateTier.ts:6) excludes them; DetectedCard.tsx:181-183,241-242 disables the CTA. Chosen fix: preselect Otto's top match on each uncertain row (selected by default, clearly changeable via the existing FoodPicker), so the log button is live immediately. Write the failing test first."
created: 2026-08-09
updated: 2026-08-09
---

# Debug: capture-card-uncertain-rows

## Symptoms

**Expected behavior:**
When Otto resolves a multi-item capture (e.g. "200ml high protein milk + nescafe mocha sachet"),
the detected-items card should present its best guess for each item already selected, so the user
can log in one tap and only intervene on rows that are wrong.

**Actual behavior:**
Every weakly-matched row renders as "Not sure which — tap to confirm" with kcal shown as "—".
Nothing is selected. The primary CTA reads "Add 0 items to diary" and is disabled, so the capture
cannot be logged at all. The user's workaround was to log each product separately via barcode scan.

**Error messages:**
None — no crash, no error toast. Silent dead-end in the UI.

**Timeline:**
Present in current main. Reported 2026-08-09 during food-logging testing.

**Reproduction:**
Capture (text or photo) a multi-ingredient phrase whose ingredients score below the 0.70
nutrition-index match floor, so `decomposeAndEstimate` assigns each candidate `tier: follow_up`.
The capture card then renders with every row uncertain and the CTA disabled.

**Confirmed in production data** (kora_db on global-postgres, user mahesh.sangawar@gmail.com):
```
08-09 06:54  snack  NESCAFÉ Mocha               10g   55 kcal  ai_barcode
08-09 06:52  snack  HIGH PROTEIN LOW FAT MILK  200g  110 kcal  ai_barcode
```
Two separate barcode logs — the multi-item capture path was not usable.

## Current Focus

status: GREEN. Fix implemented, four target suites pass, full mobile suite green, tsc clean.

next_action: Human verification — run a multi-item capture whose ingredients fall below the 0.70
match floor and confirm the card preselects each row, reads "{grams}g · Best guess — tap to change",
and logs in one tap.

reasoning_checkpoint:
  hypothesis: "A `follow_up` candidate is a WEAK match, not an absent one — decomposeAndEstimate
    (resolver.go:485-500) populates Item, PortionGrams and Kcal on every candidate it emits,
    including the ones estimateIngredientTier drops to TierFollowUp. The client nevertheless
    treats `follow_up` as unloggable (candidateTier.ts:6), which is what empties
    loggableCandidates, sets nothingToLog, and disables the CTA. The defect is the client
    conflating 'weak' with 'unusable'."
  confirming_evidence:
    - "resolver.go:490-500 — kcal is computed as top.Item.KcalPer100g * grams / 100 and set on
      the candidate BEFORE estimateIngredientTier runs; the tier never nils out the payload.
      So the data needed to preselect is already on the wire."
    - "resolver.go:511-521 — FollowUpQuestion is deliberately left empty on this path precisely
      so the client renders the detected-card and uses per-item tiers. The server's intent was
      per-row disambiguation, not a dead end."
    - "DetectedCard.tsx:181-183,241-242 — nothingToLog/ctaLabel/disabled all derive from
      loggableCandidates, so an all-follow_up resolution yields a disabled 'Add 0 items'."
    - "Test run 2026-08-09: 18 tests fail on current main against the new spec across
      candidateTier, resolutionKcal, DetectedCard and capture suites. The all-uncertain
      DetectedCard render printed 'Add 1 item to diary' with no 'Change …' affordance."
  falsification_test: "If the server omitted item/kcal/portion_grams on follow_up candidates,
    preselection would require the client to invent nutrition and the hypothesis would be dead.
    Checked resolver.go:485-500 directly — it does not omit them."
  fix_rationale: "Split the single overloaded predicate in two. `isLoggable` stops meaning
    'confident enough' (it now covers every candidate, because every candidate carries a real
    server-priced item) and a new `isUncertain` (tier === 'follow_up') carries the presentation
    concern alone. That addresses the root cause — the conflation — rather than special-casing
    the disabled button. `contributesKcal` keys off `kcal_unknown` only, so a preselected row
    contributes the server's own kcal and the header total agrees with its own rows, while a
    hand-picked row still shows '—'."
  blind_spots:
    - "Not tested: whether the server ever emits a follow_up candidate with kcal 0 from a real
      index row. If so a legitimate 0 would render as '0 kcal' — but that is pre-existing
      behaviour for auto/confirm rows too, not introduced here."
    - "The unit defect (300 ml stored as 300 g, barcode.go:75) is untouched and out of scope;
      a preselected liquid row will still say 'g'."
    - "Preselection is a product-risk change, not just a rendering one: a weak guess can now be
      logged in one tap. Mitigated by the visual treatment below, but only real usage confirms
      the caption is loud enough."

## Design judgement (recorded per the fix brief)

Preselecting means a weak match can be logged without the user reading it. The uncertain row is
therefore kept deliberately distinguishable from a confident one, on three axes:

1. Caption reads `{grams}g · Best guess — tap to change` instead of the confident row's bare
   `{grams}g`. It states the portion, that this is a guess, and the affordance, in one line —
   the previous rows gave no hint they were tappable at all, which is part of why the card read
   as broken.
2. The tile keeps the `help-circle` icon rather than the food icon.
3. Macro chips stay OFF the weak row. Fewer asserted numbers for a match we are not confident
   in, and a second, non-textual cue that the two rows are not the same kind of thing.

What it does NOT do: invent nutrition. The row's kcal and portion_grams are the server's own
values for its top match, rendered verbatim. The `kcal_unknown` "—" path is untouched and still
applies only to rows the user replaced by hand via FoodPicker (capture.tsx:732-742).

## TDD

tdd_checkpoint:
  status: green
  test_files:
    - apps/mobile/src/lib/__tests__/candidateTier.test.ts
    - apps/mobile/src/lib/__tests__/resolutionKcal.test.ts
    - apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx
    - apps/mobile/app/__tests__/capture.test.tsx
  result: "RED: 18 failed / 13+62 passed. GREEN: 93 passed / 0 failed across the four suites;
    full mobile suite 939 passed / 135 suites, no regression."

## Decision (pre-agreed with user)

Chosen fix: **preselect Otto's top match**. Each uncertain row defaults to the server's best
guess in a selected state, with a clear affordance to change it via the existing FoodPicker
(`capture.tsx:1089`). The log button is live immediately.

Constraint to respect: the client must not invent nutrition. Preselecting must carry the
server's own `kcal`/`portion_grams` for the top match verbatim — it must not resurrect the
`kcal_unknown` "—" path for rows the user never touched.

## Evidence

- timestamp: 2026-08-09 — api/internal/ai/resolver.go:443 `estimateIngredientTier` caps at
  TierConfirm but falls to TierFollowUp below the 0.70 floor; resolver.go:492 applies it per
  ingredient on the decompose path.
- timestamp: 2026-08-09 — resolver.go:511-521 deliberately leaves FollowUpQuestion empty on this
  path so the client renders the detected-card (not the dead-end follow-up branch), relying on
  per-item tiers to drive the uncertain-row UI.
- timestamp: 2026-08-09 — apps/mobile/src/lib/candidateTier.ts:6 `isLoggable` returns false for
  any `follow_up` candidate; loggableCandidates filters them all out.
- timestamp: 2026-08-09 — DetectedCard.tsx:181-183 computes `nothingToLog` / `ctaLabel` from
  loggableCandidates; :241-242 disables the Pressable when nothingToLog.
- timestamp: 2026-08-09 — DetectedCard.tsx:118-128 renders uncertain rows with a help-circle icon
  and "Not sure which — tap to confirm"; :146 shows "—" instead of kcal.
- timestamp: 2026-08-09 — capture.tsx:732-742 `effectiveResolution` promotes a hand-picked row to
  `tier: "confirm"` but sets `kcal: 0, kcal_unknown: true`, so even a corrected row shows "—".
- timestamp: 2026-08-09 — production food_logs confirm the user bypassed the capture flow entirely
  and logged the two products as separate barcode scans.

## Related defects found during investigation (NOT in this session's scope)

**B. Barcode scans ignore the product's own serving size.**
`internal/resolve/handler.go:53` hardcodes `barcodeDefaultGrams = 100.0`, used verbatim at
:219 and :223 — `item.ServingGrams` is never consulted. The NESCAFÉ Mocha row carries
`serving_grams = 16.5` (one sachet) and the milk carries `300`; both were ignored and the scan
returned 100 g. This contradicts the codebase's own convention: `resolveAliasPortion`
(internal/ai/resolver.go:176-178) explicitly prefers `item.ServingGrams` before falling back
to 100 g. The user's stored logs (200 g and 10 g) match neither the API default nor the row's
serving size — consistent with hand-editing the quantity afterwards in the diary.

**C. No unit concept — liquids are stored and displayed as grams.**
`internal/nutrition/barcode.go:75` assigns OpenFoodFacts' `serving_quantity` straight into
`ServingGrams` without reading OFF's `serving_quantity_unit`. For a liquid, OFF reports ml and
its `*_100g` nutriments are per 100 ml. The milk's 300 is 300 **ml** stored as 300 **g**.
Schema-wide there is no unit column: `food_items` has only `serving_grams` + `*_per_100g`, and
`food_logs` only `quantity_grams`, so a scanned 200 ml milk can only ever render as "200 g".

## Eliminated

(none yet)

## Resolution

root_cause: The client conflates "weak match" with "unusable". decomposeAndEstimate emits fully
  priced candidates (item + portion_grams + kcal) even when estimateIngredientTier drops them to
  TierFollowUp, but apps/mobile/src/lib/candidateTier.ts:6 `isLoggable` excludes every follow_up
  row. loggableCandidates therefore returns empty for an all-weak capture, DetectedCard.tsx:181-183
  sets nothingToLog and "Add 0 items to diary", and :241-242 disables the CTA — the capture cannot
  be logged at all despite the server having sent a usable answer for every row.
fix: Split the one overloaded predicate into two, so "can this be logged" and "how confident is
  it" stop being the same question.
  - `candidateTier.ts` — `isLoggable` now returns true for every candidate (the server prices
    every row it emits, including follow_up ones); new `isUncertain(candidate)` carries the
    presentation concern alone (`tier === "follow_up"`, so an absent tier reads as confident);
    `contributesKcal` keys off `kcal_unknown` alone, so a preselected row contributes the server's
    own kcal and a hand-picked one still contributes nothing.
  - `DetectedCard.tsx` — the row's uncertain treatment derives from `isUncertain`, not from
    `!isLoggable`. The weak row keeps its help-circle tile and its macro chips stay off, and its
    caption now reads `{grams}g · Best guess — tap to change` (portion, provenance of the choice
    and the affordance in one line) instead of "Not sure which — tap to confirm". Its
    accessibility label became `Change {name}`. Because `showsKcal` is now `contributesKcal`
    alone, the preselected row prints the server's own kcal verbatim and the header total agrees
    with its own rows.
  - `capture.tsx` — refreshed the stale handleAddToDiary comment that documented dropping
    follow_up rows from the batch.
  No client-side nutrition was introduced: every kcal and portion on a preselected row is the
  server's own value for its top match, and the `kcal_unknown` "—" path still applies only to rows
  the user replaced by hand via FoodPicker. No Go code and no server tier threshold was touched.
verification: |
  - Four target suites: 93 passed / 0 failed (were 18 failed at RED).
  - Full apps/mobile suite: 939 passed / 135 suites, 0 failed — no regression.
  - The hand-picked guard tests still pass specifically: "a hand-picked row is loggable but
    contributes no kcal" (candidateTier), "a hand-picked row is loggable but still shows no kcal"
    (DetectedCard — asserts "0 kcal" absent and "—" present), "a resolution whose every candidate
    has an unknown kcal shows a dash, not a fabricated zero" (resolutionKcal), and "picking a food
    for an uncertain item replaces the guess without inventing a kcal" (capture).
  - `npx tsc --noEmit` clean. `npm run lint` cannot run in this checkout (eslint is not installed
    — pre-existing, unrelated to this change).
  - Not yet verified by a human against a real weak-match capture on device.
files_changed:
  - apps/mobile/src/lib/candidateTier.ts
  - apps/mobile/src/components/capture/DetectedCard.tsx
  - apps/mobile/app/capture.tsx
  - apps/mobile/src/lib/__tests__/candidateTier.test.ts
  - apps/mobile/src/lib/__tests__/resolutionKcal.test.ts
  - apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx
  - apps/mobile/app/__tests__/capture.test.tsx
