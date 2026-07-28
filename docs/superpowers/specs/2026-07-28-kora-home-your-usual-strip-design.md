# Home "Your usual" strip — design spec (Food Memory Phase 2a)

**Goal:** Let a user log their habitual foods and meals from the Home screen in **one tap**, contextual to the current meal slot — extending the Personal Food Memory wedge from the Log screen onto Home.

**Branch base:** builds on `food-memory` (PR #7), which added the `memory` engine, `GET /v1/memory`, the `MealRow`/`foodVisual` food styling, and the instant-log + Undo toast.

## Behaviour

A new **"Your usual" section** on Home shows what the user usually eats **for the current meal slot** (e.g. "YOUR USUAL BREAKFAST" in the morning), as up to 4 one-tap rows.

- Tapping a **meal** row batch-logs all its items; tapping a **food** row logs that food. Both show the "Logged X — Undo" toast, identical to the Log screen.
- The section is **contextual by time of day** and **hidden entirely** when there is nothing to show (new users, or a slot with no history and no fallback).

## Data source — no backend change

`GET /v1/memory` already returns `recents`, `frequent`, and `usual_meals`, each entry tagged with `meal_slot`. Home reuses the existing `useMemory(today())` query (cache-shared with the Log screen via `queryKey ["memory", date]`) and filters **client-side** by the current slot. No new endpoint, migration, or Go change.

## Current-slot logic

**Reuse the existing `mealSlotForHour(hour: number): MealSlot`** from `src/lib/mealSlot.ts` (already used by the app for default slot selection) — the strip computes `mealSlotForHour(new Date().getHours())`. Reusing it keeps the strip's slot consistent with the slot a log defaults to, and avoids a near-duplicate. Its boundaries:

| Local hour | Slot |
|---|---|
| < 11 | `breakfast` |
| 11–15 | `lunch` |
| 16–20 | `dinner` |
| 21–23 | `snack` |

(No new `mealSlotForTime` function — this replaces the earlier plan to create one.)

## Selection logic (pure, testable)

`yourUsual(memory: Memory, slot: MealSlot): UsualRow[]` where
`UsualRow = { kind: "meal"; meal: MemoryMeal } | { kind: "food"; food: MemoryFood }`.

1. Usual **meals** whose `meal_slot === slot` (already ranked by the engine), mapped to `{kind:"meal"}`.
2. Then frequent **foods** whose `meal_slot === slot` (already ranked), mapped to `{kind:"food"}`.
3. Concatenate (meals first) and take the **first 4**.
4. **Fallback:** if steps 1–2 produced nothing, use the overall top `frequent` foods (any slot), first 4, as `{kind:"food"}`.
5. If still empty → return `[]` (the strip renders nothing).

Pure function of `(memory, slot)` — no time, no I/O — so it is fully table-testable.

## Shared instant-log hook (refactor)

The `logFood`/`logMeal` handlers currently live inline in `app/log.tsx`. Extract them into a shared hook so Home and Log share one implementation (no duplication):

`useInstantLog(): { logFood(f: MemoryFood): void; logMeal(m: MemoryMeal): void }`

- Composes `useCreateLog`, `useCreateLogBatch`, `useDeleteLog`, `useToast`.
- `logFood(f)` → `createLog.mutate({ food_item_id: f.food_item_id, meal_slot: f.meal_slot, source: "memory", quantity_grams: f.grams, logged_at: new Date().toISOString() }, { onSuccess: created => toast.show({ message: \`Logged ${f.name}\`, actionLabel: "Undo", onAction: () => deleteLog.mutate(created.id) }) })`.
- `logMeal(m)` → `batchLog.mutate({ logged_at: new Date().toISOString(), meal_slot: m.meal_slot, items: m.items.map(i => ({ food_item_id: i.food_item_id, quantity_grams: i.grams })) }, { onSuccess: created => toast.show({ message: \`Logged ${m.name}\`, actionLabel: "Undo", onAction: () => created.forEach(l => deleteLog.mutate(l.id)) }) })`.
- Client never sends macros (unchanged invariant).

`app/log.tsx` is updated to consume `useInstantLog()` instead of its inline handlers; its existing tests must stay green.

## Component

`src/components/home/YourUsualStrip.tsx` — self-contained:

- Reads `useMemory(today())` and `useInstantLog()`.
- Computes `slot = mealSlotForTime(new Date())` and `rows = yourUsual(memory.data, slot)`.
- While `memory.isLoading` or `memory.isError`, or when `rows` is empty → **renders `null`** (the strip is supplementary on Home; no spinner or error UI here — it simply appears when ready).
- Otherwise renders an `Overline` title `YOUR USUAL ${slot.toUpperCase()}` + a `<GroupedSection elevated>` of `MealRow`s:
  - meal row: `name={m.name}`, `slot={m.items.map(i=>i.name).join(" · ")}`, `kcal={m.kcal}`, `iconName`/`tint` from `foodVisual(m.name)` + `hslToHex`, `onPress={() => logMeal(m)}`.
  - food row: `name={f.name}`, `slot={\`${Math.round(f.grams)}g\`}`, `kcal={f.kcal}`, `foodVisual(f.name)`, `onPress={() => logFood(f)}`.

Placed in `app/(tabs)/index.tsx` **after the FuelStrip (ring/macros) and before the "Today" feed**.

Logging invalidates `["logs"]` + `["dashboard"]` (existing behaviour of the mutations), so Home's ring/feed refresh; `["memory"]` is intentionally not invalidated (a single log does not meaningfully move the 90-day aggregate).

## Files

- Create: `src/lib/mealSlotForTime.ts` (+ `__tests__/mealSlotForTime.test.ts`)
- Create: `src/lib/yourUsual.ts` (+ `__tests__/yourUsual.test.ts`)
- Create: `src/api/useInstantLog.ts`
- Create: `src/components/home/YourUsualStrip.tsx` (+ `__tests__/YourUsualStrip.test.tsx`)
- Modify: `app/log.tsx` (consume `useInstantLog`)
- Modify: `app/(tabs)/index.tsx` (render `<YourUsualStrip />`)

## Testing

- `mealSlotForTime`: boundary hours (03:59→snack, 04:00→breakfast, 10:59→breakfast, 11:00→lunch, 15:59→lunch, 16:00→dinner, 21:59→dinner, 22:00→snack, 00:00→snack) → correct slot.
- `yourUsual`: meals-first ordering; frequent fill after meals; cap at 4; slot filtering (wrong-slot excluded); fallback to overall frequent when slot empty; empty → `[]`.
- `YourUsualStrip` (RNTL v14, `await render`): renders the slot title + rows for a mocked memory/slot; tapping a meal row calls `logMeal`, a food row calls `logFood` (mock `useInstantLog`); empty/loading/error → renders nothing.
- `app/log.tsx` existing tests stay green after the `useInstantLog` extraction.
- `mealSlotForTime` and `yourUsual` are pure — no fake timers needed for their unit tests (pass a fixed `Date`/`Memory`).

## Constraints (inherited)

No fabricated numbers (client sends only `food_item_id` + grams + slot + `logged_at`; kcal shown is the row's stored value). User isolation and timezone handled server-side by `/v1/memory`. Tokens-only styling (`MealRow`/`foodVisual`/`hslToHex`). RNTL v14 `await render`. Single-line conventional commits, no signature, never `git add -A`.

## Out of scope (later Phase 2 items)

Manual pins/favorites; usual-meal naming & editing; the fibre dashboard tile. Each is its own spec.
