# Kora — Edit/Delete a Log + Quick-Add Water (Design)

**Date:** 2026-07-25
**Branch base:** `phase-2-nutrition-engine` (current tip)
**Fidelity ref (edit screen):** `design-system/ui_kits/kora/MealDetail.jsx` (grams Stepper, trash/delete, Save changes).

## Problem

The backend already supports editing (`PATCH /v1/logs/:id`), deleting (`DELETE /v1/logs/:id`), and water logging (`POST /v1/water`), but the mobile app has **no UI** for any of them:

- Tapping a logged meal opens `app/meal.tsx`, which is **view-only** (a single "Done" button). A user cannot fix a wrong portion, move an item to a different meal, or delete it.
- The Diary Water stat only **displays** water; the `useAddWater` hook exists but is never invoked — there is no way to add water from the app.

This closes those two gaps. Both are "backend done, mobile UI missing".

## Scope

**In scope**
1. Editable meal detail: change **portion (grams)**, change **meal slot**, and **delete** the log.
2. **Quick-add water** on the Diary screen (+250 ml / +500 ml).

**Out of scope** (deferred — noted so the plan doesn't drift into them)
- Swapping a log to a *different* food (re-search + repoint). Portion/meal only for now.
- The AI **correction-alias** (`correction_phrase` on `PATCH`): only meaningful in the capture flow where the original phrase exists; not part of manual editing.
- Repeat-log / copy-day UI (`POST /logs/:id/repeat`, `/logs/copy-day`).
- Swipe-to-delete on the Home/Diary feed rows (delete lives in the meal detail only).
- Custom water amount and water quick-add on Home (Diary presets only).

## Invariant (must hold)

Nutrition numbers are never persisted from a client computation. On the edit screen, the grams stepper may scale the **displayed** kcal/macros locally for live preview (`displayKcal = baseKcal × grams / baseGrams`), but the **saved** values come exclusively from the server's row-sourced recompute inside `PATCH /v1/logs/:id`. The client sends only `quantity_grams` and/or `meal_slot`; it never sends a nutrition number.

## Feature 1 — Editable meal detail + delete

### Data / hooks
- **New** `useEditLog()` in `src/api/hooks.ts`: `mutationFn({ id, meal_slot?, quantity_grams? })` → `apiFetch("/v1/logs/" + id, { method: "PATCH", body })`. `onSuccess` → invalidate `["logs"]` and `["dashboard"]` (the day-logs query key is `["logs", date]`; the dashboard key is `["dashboard", date]` — invalidating by prefix matches every day, mirroring `useCreateLog`).
- **New** `useDeleteLog()`: `mutationFn(id)` → `apiFetch("/v1/logs/" + id, { method: "DELETE" })`. `onSuccess` → invalidate `["logs"]` and `["dashboard"]`.
- Add an `EditLogInput` type in `src/api/types.ts`: `{ meal_slot?: MealSlot; quantity_grams?: number }` (no nutrition fields — the structural half of the invariant).
- `openMeal(...)` in **both** `app/(tabs)/index.tsx` and `app/(tabs)/diary.tsx` must also pass the log's `id` and `grams` (`quantity_grams`) as route params, alongside the existing display params.

### Screen (`app/meal.tsx`)
Adapts `MealDetail.jsx` to a single log and Kora's light theme:
- Food tile (icon from `foodVisual(name)`) + food name + live kcal.
- **Grams stepper** — reusable `Stepper` component (see below), step 10 g, minimum 10 g. Editing grams updates a local `grams` state; displayed kcal + macro tiles scale from the base values via the linear preview formula above.
- **Meal-slot selector** — four selectable chips (breakfast/lunch/dinner/snack), initial = the log's current slot.
- Footer row: **delete** (outline button, `trash-2` icon, destructive color) + **Save changes** (primary).
  - **Delete** → `Alert.alert` confirm ("Delete this entry?") → `useDeleteLog(id)` → on success `router.back()`.
  - **Save** → build a patch of only the fields that changed (grams and/or meal slot) → `useEditLog({ id, ...changed })` → on success `router.back()`. **Save is disabled** until grams or meal slot differs from the loaded values (a clean-form Save is never issued), and while a mutation is pending.
- **Error handling:** delete/save failures show an inline message (reuse the app's error text pattern; `colors.destructive`), never a silent failure. Grams < 10 cannot be reached (stepper min); Save disabled while a mutation is pending.

### Reusable component
- `src/components/Stepper.tsx`: `{ value: number; onChange: (next: number) => void; step?: number; min?: number }`. Minus/plus buttons + the numeric value, matching the mockup's control (light theme, `@repo` token styling). Pure and immutable (`onChange` returns the new value; no mutation).

## Feature 2 — Quick-add water (Diary)

### Hook
- Extend `useAddWater()` to accept `{ volume_ml: number; logged_at?: string }` (currently it takes a bare `number`; it has no callers, so the signature change is free). Send both fields in the POST body (the backend defaults `logged_at` to now when zero/absent). Keep the `["dashboard"]` invalidation.

### UI (`app/(tabs)/diary.tsx`)
- On the Water stat, add two buttons: **+250 ml** and **+500 ml**.
- Tapping calls `useAddWater({ volume_ml, logged_at: <selected diary day ISO> })` so the water lands on the day being viewed; on success the dashboard invalidates and the Water stat (and any ring) update.
- Errors surface as a brief message; no silent failure.

## Testing

- **Hook tests** (`src/api/__tests__/hooks.test.tsx`): `useEditLog` PATCHes `/v1/logs/:id` with the exact changed body and invalidates the right keys; `useDeleteLog` DELETEs `/v1/logs/:id`; `useAddWater` posts `{ volume_ml, logged_at }`. Follow the existing hook-test seam (mock `@/lib/api`).
- **meal.tsx tests** (`app/__tests__/meal.test.tsx` or extend existing): stepper +/− adjusts grams and the live kcal; meal-slot change; Save sends only the changed fields (grams-only, slot-only, both); Save is disabled on a clean form; Delete triggers confirm then `useDeleteLog`.
- **Diary water test:** tapping **+250 ml** calls `useAddWater` with `250` and the selected day.
- All: `npx tsc --noEmit` clean, `npm test -- --ci` green (RNTL v14 async `render`/`fireEvent`).

## Files touched
- `src/api/hooks.ts` (add `useEditLog`, `useDeleteLog`; extend `useAddWater`)
- `src/api/types.ts` (`EditLogInput`)
- `src/components/Stepper.tsx` (new)
- `app/meal.tsx` (editable)
- `app/(tabs)/index.tsx`, `app/(tabs)/diary.tsx` (`openMeal` params; Diary water buttons)
- Tests alongside each.

No backend changes (all three endpoints already exist and are reviewed).
