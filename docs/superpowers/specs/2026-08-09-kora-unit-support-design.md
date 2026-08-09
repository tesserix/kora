# Kora — Food Unit Support

**Date:** 2026-08-09
**Status:** Approved design, ready for planning

## Problem

Kora stores every food quantity as grams and nothing else. `food_items` carries
`serving_grams` and `*_per_100g`; `food_logs` carries `quantity_grams`. There is no column
anywhere that could record a different unit.

Two consequences, both observed in production:

1. **Liquids are mislabelled.** `api/internal/nutrition/barcode.go:75` assigns OpenFoodFacts'
   `serving_quantity` into `ServingGrams` and drops OFF's `serving_quantity_unit`. The scanned
   product `9310232956596` (HIGH PROTEIN LOW FAT MILK) has a 300 **ml** serving stored as
   `serving_grams = 300`, so a 200 ml pour can only ever render as "200 g".
2. **Named servings are unreachable.** The scanned NESCAFÉ Mocha sachet (`9300605158641`) has
   `serving_grams = 16.5` — one sachet — but there is no way to log "1 sachet". The user
   hand-typed 10 g, under-counting the entry by a third.

A related defect on the same data was fixed separately in commit `afe2db0` (the barcode path now
prefers `item.ServingGrams` over a flat 100 g). That fix makes the correct *number* reach the
client. This spec makes the correct *unit* reach the client.

## Goals

- A food item knows whether it is measured in mass or volume, and displays accordingly.
- A food item can carry named servings ("sachet", "slice", "cup") with a known base amount.
- Logging defaults to one natural serving, with an escape hatch for exact amounts.
- The diary shows a portion the way it was entered, after reload, indefinitely.
- No fabricated nutrition numbers enter the system.

## Non-goals

Out of scope, tracked separately: multi-ingredient meal creation; the reminders/notifications
work; any change to `estimateIngredientTier` or the resolve tier thresholds. The capture card's
preselection behaviour (commit `d701c8f`) needs no unit-aware change beyond shared formatting.

Imperial food portions are explicitly out of scope. The existing metric/imperial preference in
`apps/mobile/src/units/convert.ts` continues to govern body weight and water only. Food portions
are always metric.

## Core invariant

**Nutrition is computed from `quantity_grams` multiplied by the row's per-100 figures,
server-side, always.**

Units are an entry-and-display concern. A unit resolves to `quantity_grams` once, at write time,
and is never re-resolved on read. This is what makes historical logs immune to later corrections
of a density or a serving mass: fixing a wrong conversion changes future logs only, and never
silently rewrites what a past day's totals said.

## Data model

### `food_items` (migration `000026_food_units`)

| Column | Type | Default | Meaning |
|---|---|---|---|
| `base_unit` | text | `'g'` | `'g'` or `'ml'`. The unit its `*_per_100g` figures are actually per-100 **of**. |
| `serving_units` | jsonb | `'[]'` | Named servings: `[{"name":"sachet","amount":1,"base_amount":16.5}]` |

`base_unit` is constrained to `('g','ml')`. For an OFF liquid, `*_per_100g` values are already
per 100 ml — OFF reports them that way — so no numeric conversion is needed, only correct
labelling. The existing column names stay as they are; renaming `kcal_per_100g` to something
unit-neutral would touch every service and buy nothing.

`serving_units` entries record `base_amount` in the item's `base_unit`. `amount` is the count the
name refers to, almost always 1, present so `"2 biscuits (30g)"` parses without lying about what
one biscuit weighs.

### `food_logs` and `saved_meal_items`

| Column | Type | Default | Meaning |
|---|---|---|---|
| `entered_amount` | numeric | null | What the user actually entered |
| `entered_unit` | text | null | The unit they entered it in |

Both nullable. Null means a legacy gram-entered row and formats as grams. `quantity_grams` keeps
its exact current meaning and remains the sole input to every nutrition total.

## Server: `api/internal/units`

A new package, no dependencies on `nutrition` or `ai` beyond types.

```
Parse(servingDesc, offServingSize string) ([]ServingUnit, error)
Table                                      // curated fallback, a Go map in-repo
ToBase(amount float64, unit string, item nutrition.FoodItem) (float64, error)
```

**`Parse`** extracts structured servings from the label text already present on the row.
`api/internal/nutrition/seed_data.go` uses exactly the target format throughout —
`"1 cup (158g)"`, `"2 biscuits (30g)"`, `"1 tsp (5g)"`, `"45g pack"` — so this is high-yield from
day one on the ~7,900 seeded rows.

**`Table`** is consulted only on a parse miss: a curated map of category densities (cups of rice,
flour, milk) and common count servings (slice, scoop, sachet). Shipped in the repo, reviewed like
code.

**`ToBase`** is the single conversion entry point. It returns an error rather than guessing when
no conversion exists. No caller may substitute a default on that error path — they fall back to
raw base-unit entry instead.

Nothing in this package calls an LLM. Every number it produces is traceable to a parsed label,
the curated table, or the food row itself.

### Ingest change

`api/internal/nutrition/barcode.go` reads OFF's `serving_quantity_unit` and sets `base_unit`, and
runs `serving_size` text through `Parse` to populate `serving_units`. This alone corrects the milk.

## Client

`apps/mobile/src/units/convert.ts` is left untouched — it keeps owning body weight and water.
Food units get a sibling module, `apps/mobile/src/units/portion.ts`. No shared state between them.

**`formatPortion(entry)`** — one function, four cases: a named serving (`"1 sachet"`), a volume
(`"200 ml"`), a mass (`"140 g"`), and a legacy null (`"140 g"`). Every read-only surface uses it,
so all of them agree: capture card, ask-again sheet, diary rows, meal editor header, saved-meal
sheet, pinned strip, usual strip.

**`PortionField`** — a new component owning serving-first entry. Default state is a stepper
showing `1 sachet (16.5 g)` with +/− controls. An "enter exact amount" link swaps in a number
field with a unit dropdown seeded from the item's own units plus its base unit. It replaces the
raw grams inputs in the meal editor, the saved-meal sheet, and the log screen.

An item with no `serving_units` has no stepper — `PortionField` opens directly in exact-amount
mode, which is precisely today's behaviour. The feature degrades to the status quo rather than
to an error.

## Migration and backfill

Migration `000026_food_units` adds six columns with defaults, so it is non-blocking:
`base_unit` and `serving_units` on `food_items`, and `entered_amount` / `entered_unit` on both
`food_logs` and `saved_meal_items`.

Backfill is trivial at current scale — production holds 7,900 `food_items` (only **6** with
`provenance = 'off'`), **6** `food_logs`, and **0** `saved_meal_items`:

1. `base_unit` defaults to `'g'` for every existing row. Correct for all ~7,894 USDA/AFCD rows.
2. A one-off re-fetch of the 6 OFF-provenance rows picks up their true `serving_quantity_unit`
   and populates `serving_units`.
3. `serving_units` is populated for seeded rows by running `Parse` over their existing
   `serving_desc` as part of the migration's data step.
4. `entered_amount`/`entered_unit` stay null on the 6 existing logs. `formatPortion` handles null.

The down migration drops all six columns. Lossless, because `quantity_grams` is never modified.

## Error handling

- Parse failure is non-fatal: the item simply has no named servings.
- `ToBase` returning an error surfaces as a form validation message. Never a silent default.
- Ingest logs parse misses with the offending text, so the curated table can be grown from real
  observed data rather than guesswork.
- A `base_unit` outside `('g','ml')` is rejected at the DB constraint and at admin mutation
  validation.

## Testing

**Go.** Table tests on `Parse` covering every label format present in `seed_data.go` and the OFF
responses for the two known barcodes; `ToBase` across each unit kind plus the no-conversion error
path; the migration's backfill asserted against a seeded fixture.

**TypeScript.** `formatPortion` across all four cases including legacy null. `PortionField`
interaction tests: stepper increments, the exact-amount escape hatch, unit dropdown seeding, and
rejection of zero/negative amounts. Regression coverage that the eight read-only surfaces render
through `formatPortion` rather than inlining `${grams}g`.

## Known limitation

Household measures are the weakest leg of this design. Count servings and volumes come cheaply
because that data genuinely is in the labels. Cups need per-food density, which neither OFF nor
USDA provides in usable form, so `Table` will start small — roughly a dozen staples. Cups will be
honestly useful for rice, flour, and milk, and absent for most branded products, where the item
falls back to its named serving or raw mass.

This is a deliberate trade: an absent conversion is recoverable, a fabricated density silently
corrupts every total that uses it. If broad cup support is needed later, it wants its own
data-sourcing spec rather than an inline guess here.

## Rejected alternatives

**Separate `food_item_units` table.** More normalized, better if admins ever curate units at
scale or share a density across a whole category. Rejected for now: it costs a join on every
resolve and a second migration surface, to buy flexibility there is no evidence yet of needing.

**Client-side unit layer only.** Extend `convert.ts`, keep the server gram-only. Ships fastest and
needs no migration, but the entered unit is never persisted, so the diary cannot say "1 sachet"
after a reload — which is the actual request.

**LLM-supplied grams-per-unit at resolve time.** Widest coverage, no curation. Rejected because it
puts a fabricated number directly into the nutrition path, which this codebase forbids everywhere
else (see the verbatim-rendering comments throughout `DetectedCard.tsx` and the row-sourced-kcal
invariant in `resolver.go`).
