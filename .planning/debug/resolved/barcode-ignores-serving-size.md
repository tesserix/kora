---
status: resolved
trigger: "Scanned a NESCAFE Mocha sachet and the app did not use the per-serving measurement — it assumed a generic portion, so the user had to hand-edit the quantity in the diary afterwards."
created: 2026-08-09
updated: 2026-08-09
---

# Debug: barcode-ignores-serving-size

## Symptoms

**Expected behavior:**
Scanning a packaged product should log one serving of that product by default. The NESCAFÉ Mocha
sachet is a single-serve unit and OpenFoodFacts already reports its serving size, so a scan should
come back as ~16.5 g (one sachet), not a generic portion.

**Actual behavior:**
Every barcode scan returns exactly 100 g regardless of the product. The user had to hand-correct
the quantity in the diary afterwards — and, having no serving size shown anywhere, guessed 10 g
for a 16.5 g sachet.

**Error messages:**
None. Silent wrong-default.

**Timeline:**
Present in current main. Reported 2026-08-09.

**Reproduction:**
Scan any barcode whose `food_items` row has a non-zero `serving_grams`. The resolve response
carries `portion_grams: 100` instead of the row's serving size.

**Confirmed in production data** (kora_db on global-postgres):
```
NESCAFÉ Mocha              serving_grams = 16.5   545.45 kcal/100g   barcode 9300605158641
HIGH PROTEIN LOW FAT MILK  serving_grams = 300     55.00 kcal/100g   barcode 9310232956596
```
Both scanned; both returned 100 g. The user's stored logs (10 g and 200 g) match neither the API
default nor the row's serving size, confirming manual correction after the fact.

## Current Focus

hypothesis: `internal/resolve/handler.go` defines `barcodeDefaultGrams = 100.0` (:53) and uses it
unconditionally to build the resolved candidate — `PortionGrams: barcodeDefaultGrams` (:223) and
`kcal := item.KcalPer100g * barcodeDefaultGrams / 100` (:219). `item.ServingGrams` is loaded from
the row but never consulted, so a product's own serving size can never reach the client.

test: Table test on `ResolveBarcode` — given a found FoodItem with `ServingGrams = 16.5`, assert
the response candidate has `portion_grams == 16.5` and `kcal == KcalPer100g * 16.5 / 100`; given
`ServingGrams = 0`, assert it still falls back to 100 g.

expecting: The first case fails on current main (returns 100 g); the fallback case passes.

next_action: RED confirmed. Apply the minimal fix in `ResolveBarcode` so the portion prefers
`item.ServingGrams`, then re-run to GREEN.

reasoning_checkpoint:
  hypothesis: "`ResolveBarcode` hardcodes `barcodeDefaultGrams` (100.0) as the portion and as the
    kcal multiplier, so `item.ServingGrams` — which is populated on the row — can never reach the
    client. Every barcode scan therefore returns 100 g."
  confirming_evidence:
    - "api/internal/resolve/handler.go:219,223 read `barcodeDefaultGrams` verbatim; `ServingGrams`
      appears nowhere in the function (verified by reading the whole file)."
    - "New table test fails on main with portion 100 for ServingGrams=16.5 and =300, and passes
      for ServingGrams=0 — the exact signature of an ignored field, not a scaling bug."
    - "api/internal/nutrition/model.go:46 defines ServingGrams on FoodItem, and
      internal/nutrition/barcode.go populates it from OFF's serving_quantity."
  falsification_test: "If the portion were wrong for ServingGrams=0 too, or if the failure delta
    did not equal exactly (100 - ServingGrams), the cause would be a scaling/serialization bug
    rather than an ignored field. Observed deltas were exactly -83.5 and +200."
  fix_rationale: "Prefer `item.ServingGrams` when > 0, else 100 g — mirroring
    `resolveAliasPortion` (internal/ai/resolver.go:176-178). Addresses the root cause (field never
    consulted), not the symptom, and keeps kcal derived solely from the row."
  blind_spots: "Unit semantics are untouched: OFF's `serving_quantity_unit` is still dropped, so a
    300 ml milk remains stored as 300 g. Out of scope by agreement. Also not covered: whether any
    client caches the old 100 g default."

tdd_checkpoint:
  test_file: "api/internal/resolve/handler_test.go"
  test_name: "TestResolveBarcode_PortionPrefersServingGrams"
  status: "red"
  failure_output: "Max difference between 16.5 and 100 allowed is 1e-09, but difference was -83.5
    / Max difference between 89.99925 and 545.45 ... was -455.45075 (fallback subtest PASSes)"

## Decision (pre-agreed with user)

Fix the barcode path to mirror the convention the codebase already uses on the alias path:
`resolveAliasPortion` (internal/ai/resolver.go:176-178) prefers `item.ServingGrams` and falls back
to `defaultAliasPortionGrams = 100`. The barcode path should do the same. Keep the invariant that
kcal is derived only from the row: `KcalPer100g * grams / 100`.

Out of scope for this session: the unit problem (OFF's `serving_quantity_unit` is dropped at
internal/nutrition/barcode.go:75, so a 300 ml milk is stored as 300 g). Tracked separately as
full unit support.

## Evidence

- timestamp: 2026-08-09 — internal/resolve/handler.go:53 `const barcodeDefaultGrams = 100.0`.
- timestamp: 2026-08-09 — handler.go:219,223 use the constant verbatim; `item.ServingGrams` is
  never read anywhere in `ResolveBarcode`.
- timestamp: 2026-08-09 — internal/ai/resolver.go:176-178 `resolveAliasPortion` prefers
  `item.ServingGrams` before the 100 g fallback — the convention this path diverges from.
- timestamp: 2026-08-09 — internal/nutrition/barcode.go:75 does populate `ServingGrams` from OFF's
  `serving_quantity`, so the data is present on the row at scan time.
- timestamp: 2026-08-09 — apps/mobile/app/capture.tsx:1021 sends `candidate.portion_grams`
  straight through to the log, so the API default is what lands in the diary.

## Eliminated

(none yet)

## Resolution

root_cause: `ResolveBarcode` in api/internal/resolve/handler.go used the `barcodeDefaultGrams`
  constant (100.0) unconditionally — both as the emitted `PortionGrams` and as the kcal
  multiplier. `item.ServingGrams` was populated on the row by the OFF ingest path but was never
  read in the barcode handler, so a packaged product's own serving size could not reach the
  client. Every scan returned exactly 100 g.

fix: Added `barcodePortionGrams(item)`, which prefers `item.ServingGrams` when > 0 and falls back
  to `barcodeDefaultGrams` otherwise — the same fallback chain as `resolveAliasPortion` in
  package ai. `ResolveBarcode` now computes `grams := barcodePortionGrams(*item)` and uses it for
  both `PortionGrams` and `kcal := item.KcalPer100g * grams / 100`, preserving the invariant that
  kcal is derived solely from the row.

verification: TDD. Added table test `TestResolveBarcode_PortionPrefersServingGrams`
  (api/internal/resolve/handler_test.go) covering ServingGrams 16.5 (NESCAFÉ sachet), 300 (milk),
  and 0 (fallback). RED before the fix — the two serving-size cases failed with portion 100 and
  deltas of exactly -83.5 and +200, while the fallback case passed. GREEN after the fix, all
  three subtests. Regression: `go build ./...`, `go vet ./internal/resolve/`, and the full
  `go test ./...` API suite all pass; pre-existing `TestResolveBarcode_Found` (ServingGrams unset)
  still passes via the fallback. Not yet verified: an end-to-end scan against real OFF data on
  device.

files_changed:
  - api/internal/resolve/handler.go
  - api/internal/resolve/handler_test.go
