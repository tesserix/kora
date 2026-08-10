# Kora — Multi-Ingredient Meal Creation

**Date:** 2026-08-10
**Status:** Approved design, ready for planning

## Problem

A drink like "200 ml high protein milk + one NESCAFÉ Mocha sachet" is one thing the user consumes,
but Kora has no way to record it as one thing. The observed workaround, from production data:

```
08-09 06:54  snack  NESCAFÉ Mocha               ai_barcode
08-09 06:52  snack  HIGH PROTEIN LOW FAT MILK   ai_barcode
```

Two separate barcode scans, every time.

The backend already models the answer. `saved_meals` + `saved_meal_items` carry name, meal slot,
per-item food, grams, position, and — since the unit work merged in `c556d9c` — `entered_amount`
and `entered_unit`. `api/internal/savedmeals` has full CRUD. The gap is entirely client-side:

- `SavedMealSheet.tsx` can rename a meal, change item portions, and remove items, but has **no way
  to add one**.
- Its `Seed` type is `{mode:"create", meal: MemoryMeal} | {mode:"edit", meal: SavedMeal}` — both
  require an existing meal. There is no blank slate.
- Nothing lets a user say "those two diary rows were actually one drink".

One server-side gap compounds it: the batch-log endpoint that logs a saved meal carries only
`food_item_id` + `quantity_grams`, so a meal saved as "1 portion" logs back as "16.5 g".

## Goals

- Build a meal from scratch, adding ingredients by search.
- Turn two or more existing diary entries into a saved meal, retroactively.
- Log a saved meal and see its ingredients in the units they were saved in.

## Non-goals

Reordering ingredients, meal photos, per-item notes, and editing the diary rows a meal was composed
from. Also out of scope: the four follow-ups recorded from the unit work (`Parse` and fraction
forms, the frozen macro preview, `serving_units` on log reads, and the two small test gaps).

## Approach

Extend the surfaces that already exist rather than building a parallel meal editor. `SavedMealSheet`
is already mounted globally by `SavedMealSheetProvider`, `FoodPicker` already has the right
interface (`{visible, initialQuery, onSelect, onClose}`), and `EditItem` already carries the unit
fields. A dedicated full-screen builder was considered and rejected: it would duplicate everything
the sheet does and leave two editors to keep in sync, to buy room for features listed as non-goals.

## Seeds

`Seed` gains two variants:

```ts
type Seed =
  | { mode: "create"; meal: MemoryMeal }   // existing — from a detected usual meal
  | { mode: "edit"; meal: SavedMeal }      // existing
  | { mode: "blank" }                      // new — build from nothing
  | { mode: "compose"; items: ComposedItem[] }  // new — from selected diary rows
```

`SavedMealSheetProvider` exposes `openBlank()` and `openCompose(items)` alongside today's
`openCreate`/`openEdit`. `ComposedItem` carries exactly what a diary row already has: `food_item_id`, `name`,
`quantity_grams`, `entered_amount`, `entered_unit`, and `base_unit`.

It deliberately does **not** carry `serving_units` — food-log reads do not return them (a known
follow-up from the unit work). A composed item therefore opens in `PortionField`'s exact-amount
mode rather than a stepper, showing the right number in the right unit but without +/- controls.
The alternative — fetching each food to hydrate its servings — is a request per selected row for a
control the user may never touch. When `serving_units` does land on log reads, composed items get
their steppers with no change to this design.

## Blank-slate creation

Entry point: a "+ New meal" action on the manual Log screen (`app/log.tsx`), which already hosts
the Saved and Recents sections and the food search a user would reach for next.

The sheet opens with an empty name field focused and no items. Save stays disabled until there is
a name and at least one item with a positive quantity. That rule already exists in `save()`, but
today it surfaces as an error message after a failed press; on a blank sheet it must read as a
not-yet-ready button rather than an error the user caused.

## Adding ingredients

A "+ Add ingredient" row sits at the bottom of the item list in every mode, blank or not. It opens
`FoodPicker` with an empty query. On select, a new `EditItem` is appended, seeded the same way
`app/log.tsx` seeds its own selection:

- count from `defaultServingCount(serving_grams, servingUnits[0])`
- grams from `baseQuantityFor(count, unitName, servingUnits)`

So a picked sachet lands as **"1 portion"**, not "16.5 g". Each row keeps the `PortionField` it
already has, so the count is editable in the food's own unit.

## Diary compose

Long-pressing a diary row enters selection mode. Rows gain checkboxes; a header bar shows
"N selected" with **Save as meal** and **Cancel**. Confirming calls `openCompose(rows)`, seeding
the sheet with each row's food, portion, and entered unit, and pre-filling the name from the first
item so the user edits rather than types from nothing.

Two deliberate constraints:

- **The original diary entries are left untouched.** Composing bookmarks a combination for future
  logging; it does not rewrite what was eaten. A user who wants the day's entries merged can delete
  them by hand.
- **Selection is scoped to one day**, which is also the only data the diary screen has loaded.

## Batch logging with units

`BatchItem` (`api/internal/foodlog/service.go`) gains `EnteredAmount *float64` and
`EnteredUnit *string`. `CreateBatch` resolves each item through the same `units.ResolveEntered`
helper `LogFood` already uses, so the two write paths cannot drift — that shared helper exists
precisely because an earlier review found the duplication.

`useInstantLog.logMeal` passes each saved item's stored pair through. A saved meal then logs as
"1 portion" exactly like a direct entry, and the diary renders it that way via `formatPortion`.

The core invariant is unchanged and must stay so: **nutrition is computed from `quantity_grams` ×
the row's per-100 figures, server-side, always**, and a unit resolves to grams exactly once, at
write time.

## Error handling

- Save failures keep the existing inline message in the sheet.
- A batch where one item's unit no longer resolves — because the food was edited or retired —
  fails the **whole batch**. `CreateBatch` runs inside a transaction and returns on the first bad
  item, so a partial meal can never reach the diary. This is existing, deliberate behaviour: the
  handler already looks the food's name up (bypassing the soft-delete filter purely for the
  message) so the error names the unavailable ingredient rather than an opaque id. Unit-resolution
  failures must join that same path and reuse `units.UnrecognisedUnitMessage`, naming the
  ingredient the same way — not introduce a second, partial-success shape.
- `FoodPicker` returning a food with no `serving_units` degrades to exact-amount entry in the base
  unit, which is `PortionField`'s existing behaviour.

## Testing

**Go.** `CreateBatch` with a mix of entered-unit and gram-only items, asserting each resolves to
the right `quantity_grams`; a batch where one item's unit is unresolvable, asserting the per-item
failure is reported and the other items' outcomes are still distinguishable.

**TypeScript.** Blank sheet save-gating (disabled with no name, disabled with a name but no items,
enabled once both are present); add-ingredient seeding a named serving rather than raw grams;
diary selection mode entering on long-press and clearing on cancel; `openCompose` carrying entered
units into the sheet; and `logMeal` sending the entered pair rather than grams.

## Known limitation

Diary compose can only combine rows from the day currently on screen. Combining across days would
need a different selection surface and is not worth building until someone asks for it.
