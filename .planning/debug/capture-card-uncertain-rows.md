---
status: investigating
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

hypothesis: Ingredients from `decomposeAndEstimate` scoring under the 0.70 floor are assigned
`TierFollowUp` by `estimateIngredientTier` (api/internal/ai/resolver.go:443). `isLoggable`
(apps/mobile/src/lib/candidateTier.ts:6) treats any `follow_up` candidate as non-loggable, so
`loggableCandidates` returns empty, `nothingToLog` is true, and the CTA is disabled
(DetectedCard.tsx:181-183, 241-242). Nothing preselects the top match, so an all-weak resolution
is unloggable without one manual FoodPicker round-trip per row.

test: Render DetectedCard with a resolution whose candidates all carry `tier: "follow_up"`;
assert the CTA is enabled and labelled for the full candidate count, and that each row shows its
top-match name as the selected default rather than a bare "tap to confirm" placeholder.

expecting: Test fails on current main — CTA is disabled and labelled "Add 0 items to diary".

next_action: Write the failing test first (TDD), then implement preselect-top-match.

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

root_cause:
fix:
verification:
files_changed:
