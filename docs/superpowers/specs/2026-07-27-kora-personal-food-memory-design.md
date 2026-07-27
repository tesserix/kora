# Kora — Personal Food Memory (v1) — Design Spec

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation plan
**Differentiator context:** "The easiest nutrition tracking experience ever." Personal Food Memory is the substrate that makes daily logging *fastest* — Kora surfaces the foods and meals you already log and lets you re-log them in one tap. It is also the foundation the AI Coach later reuses ("looks like your usual breakfast").

---

## 1. Goal & Scope

Let a returning user re-log what they usually eat in **one tap**, with zero setup.

**In scope (v1):**
- A backend read endpoint that derives, from the user's own log history: **Recents**, **Frequent** foods, and auto-detected **Usual meals**.
- A **memory library** in the Log screen: `Recents · Frequent · Usual meals` tabs above the existing food search.
- **One-tap instant logging** with an **Undo** toast (single food or whole meal).
- A small **batch-log** endpoint so a usual meal logs/undoes atomically.

**Out of scope (explicitly deferred):**
- Home contextual "Your usual" strip → **Phase 2** (separate spec; reuses this endpoint).
- Manual favorites / pinning (decision: fully automatic).
- Meal naming/editing UI, saved custom meals, recipes.
- AI Coach, insights, fibre-dashboard work (tracked separately).

---

## 2. Data foundation

Reuses the existing `food_logs` table — no schema change for memory. Relevant columns: `user_id`, `food_item_id` (nullable), `logged_at`, `meal_slot`, `description`, `quantity_grams`, `kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `provenance`, `source`.

**Food identity key** (how two logs count as "the same food") = **`food_item_id`**.

Every `food_log` already has a `food_item_id`: the existing `foodlog.Create` service **requires** it (`"food_item_id is required"`) and derives all macros from the item (per-100g × grams). AI photo/text/voice logs also resolve to a food item before logging. So there are no item-less logs — identity is simply `food_item_id`, and this uniform path keeps the no-fabrication invariant airtight.

---

## 3. Algorithm (pure Go, deterministic, unit-testable)

All computation runs on-read over the user's logs in a trailing window, scoped to `user_id`. Day bucketing uses the user's timezone (existing `LocFromContext`).

**Tunable constants (v1 defaults):**
- `WINDOW_DAYS = 90`
- `RECENTS_LIMIT = 20`
- `FREQUENT_MIN_COUNT = 2`
- `FREQUENT_LIMIT = 20`
- `USUAL_MEAL_MIN_DAYS = 3` (a food-set must recur on ≥3 distinct days to be a "usual meal")
- `USUAL_MEALS_LIMIT = 12`

### 3.1 Recents
Distinct foods by identity key, ranked by most-recent `logged_at` desc, limit `RECENTS_LIMIT`. Each carries its **most-recent** portion (`grams`) + `meal_slot` and the macros for that occurrence.

### 3.2 Frequent
Foods whose occurrence count in the window ≥ `FREQUENT_MIN_COUNT`. Rank: **count desc → last_logged_at desc → name asc** (recency as a deterministic tie-break; no fractional decay in v1). Limit `FREQUENT_LIMIT`.
Each carries the **mode portion** (most-common `quantity_grams`; tie-break = the mode value seen most recently) + the most-common `meal_slot`.

### 3.3 Macros for a memory food (never fabricated)
Macros = `FoodItem` per-100g × `grams` / 100, computed server-side (same math as `foodlog.Create`). The `name` is the `FoodItem.Name`. Nothing is ever taken from the client.

### 3.4 Usual meals (clustering)
1. **Meal instance** = the set of logs sharing `(local-day-in-user-tz, meal_slot)`. (meal_slot already segments breakfast/lunch/dinner/snack; a day's "breakfast" is one instance.)
2. **Fingerprint** = the deduped **set of food identity keys** in that instance. Instances with only one distinct food are dropped (single foods live in Frequent).
3. **Usual meal** = a fingerprint appearing on **≥ `USUAL_MEAL_MIN_DAYS`** distinct days. Rank by occurrence count desc → last_seen desc. Limit `USUAL_MEALS_LIMIT`.
4. Each usual meal carries: `meal_slot`, component foods (each a memory food per §3.3 using its **mode portion within this fingerprint's instances**), summed totals, `count` (distinct days), `last_logged_at`.
5. **Derived name:** components sorted by kcal desc → name asc; name = human-join of component names (all if ≤3, else first 2 + " +N more"). Example: "Oats, Banana & Coffee".

Determinism: stable secondary sorts everywhere; the whole pipeline is a pure function of `(logs, tz, now)` → fully table-testable.

---

## 4. API

### 4.1 `GET /v1/memory`
Query: `?date=YYYY-MM-DD` (optional; the day being logged to, for tz/day context; defaults to today in the user's tz).
Auth: standard user middleware (user provisioned/resolved as usual).

Response `200`:
```json
{
  "recents":      [ MemoryFood, ... ],
  "frequent":     [ MemoryFood, ... ],
  "usual_meals":  [ MemoryMeal, ... ]
}
```

`MemoryFood`:
```json
{
  "food_item_id": "uuid",
  "name": "string",
  "meal_slot": "breakfast | lunch | dinner | snack",
  "grams": 60,
  "kcal": 389, "protein_g": 13.5, "carbs_g": 66.3, "fat_g": 6.9, "fiber_g": 10.1,
  "count": 14,
  "last_logged_at": "2026-07-26T07:12:00Z"
}
```

`MemoryMeal`:
```json
{
  "id": "string (stable fingerprint hash)",
  "name": "Oats, Banana & Coffee",
  "meal_slot": "breakfast",
  "items": [ MemoryFood, ... ],
  "kcal": 512, "protein_g": 17.0, "carbs_g": 88.0, "fat_g": 8.2, "fiber_g": 12.3,
  "count": 9,
  "last_logged_at": "2026-07-26T07:14:00Z"
}
```

Empty history → all arrays empty (never an error).

### 4.2 `POST /v1/logs/batch` (new — atomic meal logging)
Request (no client macros — mirrors the single-log create's `{food_item_id, grams}` contract):
```json
{
  "logged_at": "2026-07-27T12:00:00Z",
  "meal_slot": "breakfast",
  "items": [
    { "food_item_id": "uuid", "grams": 60 },
    { "food_item_id": "uuid", "grams": 120 }
  ]
}
```
Behaviour: creates one `FoodLog` per item (all with the given `logged_at` + `meal_slot`), in **one transaction**, resolving each item and computing macros server-side exactly as `foodlog.Create` does (`item per-100g × grams`). Returns the created logs **with ids** so the client can Undo by deleting them.
Validation: `items` non-empty; each `grams > 0` and `food_item_id` present/resolvable; valid `meal_slot`. Errors use the standard envelope (400 validation / 500 infra-generic). If any item fails to resolve, the whole batch rolls back (atomic).

### 4.3 Single-food logging
Reuses the existing `POST /v1/logs`. No change.

---

## 5. Mobile UX

**Log screen (`app/log.tsx`):** above the existing search field, add a `Segmented` header — **Recents · Frequent · Usual meals** (default tab: Recents). Below it, the active tab's list.
- **Food row:** reuse `FoodTile` — name, portion, macro chips, subtle meal-slot hint. Tap → `POST /v1/logs` built from the `MemoryFood` → **"Logged — Undo"** toast.
- **Usual-meal row:** meal name + component-food chips + total macros + "×N" count badge. Tap → `POST /v1/logs/batch` → **"Logged meal — Undo"** toast.
- **Undo:** the toast's Undo action deletes the just-created log (or each id from the batch) via the existing delete endpoint. Undo window ~5s.
- Searching still works exactly as today; the memory header sits above it and collapses when the search field is focused/has a query.
- **State:** `useMemory(date)` React Query hook (`GET /v1/memory`). On any log/undo, invalidate `dashboard` + `dayLogs` (existing keys) so Home/Diary update. Loading → skeleton rows; error → inline retry; empty → hide the tab bar / show a gentle "Log a few meals and your favorites show up here."

---

## 6. Invariants & constraints

- **No fabricated numbers:** every macro is computed server-side as `FoodItem` per-100g × grams; the client never sends macros (memory-read computes for display; batch-create computes on write). Portions are the user's actual grams (mode / most-recent).
- **User isolation:** every query filtered by `user_id` (tenant pattern); batch-create writes only the caller's rows.
- **Timezone:** day grouping uses the user's tz via `LocFromContext`.
- **Determinism:** clustering/ranking is a pure function → stable, testable; all sorts have deterministic tie-breaks.
- **Tokens-only** mobile styling; reuse `FoodTile`, `Segmented`, existing toast.
- **Cost:** no new tables, no cron/jobs (Approach A). Optional short Redis cache only if profiling later demands it.

---

## 7. Testing

**Go (unit + handler):**
- Recents ranking + most-recent portion.
- Frequent: min-count gate, count→recency→name ordering, mode-portion selection incl. tie-break.
- Macros computed as item per-100g × grams (server-side, matches `foodlog.Create`).
- Usual meals: instance grouping by (tz-day, slot), fingerprint dedup, single-food exclusion, ≥3-day threshold, totals, derived name, ordering.
- User isolation (another user's logs never leak).
- `GET /v1/memory` handler (200 shape, empty history).
- `POST /v1/logs/batch` handler (atomic create, server-computed macros, validation 400s, rollback when any item unresolvable, isolation).

**Mobile:**
- `useMemory` hook (fetch + shape mapping).
- Log-library renders three tabs; switching tabs shows the right list.
- Tap food → single-log mutation payload; tap meal → batch payload; Undo → delete call(s).
- Empty/loading/error states.

---

## 8. Phasing

- **v1 (this spec):** `GET /v1/memory` + `POST /v1/logs/batch` + Log-screen memory library + Undo.
- **Phase 2 (later spec):** Home contextual "Your usual" strip — reuses `/v1/memory`, filtered to the current meal-slot/time-of-day, for logging without opening the Log screen.

---

## 9. Open tunables (chosen defaults, easy to revisit)
`WINDOW_DAYS=90`, `USUAL_MEAL_MIN_DAYS=3`, `FREQUENT_MIN_COUNT=2`, list limits per §3. These are constants in one place; adjust after real-data feedback.
