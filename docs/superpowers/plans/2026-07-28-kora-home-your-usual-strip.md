# Home "Your usual" strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a contextual "Your usual" section to the Home screen that shows the user's usual meals/foods for the current meal slot and logs them in one tap.

**Architecture:** Pure client-side. A pure selector (`yourUsual`) filters the existing `GET /v1/memory` payload by the current meal slot (from the existing `mealSlotForHour`). A new self-contained `YourUsualStrip` component renders up to 4 `MealRow`s and logs via a shared `useInstantLog()` hook extracted from `app/log.tsx`. No backend change.

**Tech Stack:** Expo/React Native + TypeScript + React Query + Reanimated. Spec: `docs/superpowers/specs/2026-07-28-kora-home-your-usual-strip-design.md`.

## Global Constraints

- **No fabricated numbers:** the client sends only `food_item_id` + `quantity_grams` + `meal_slot` + `logged_at`; displayed kcal is the row's stored value. Never send macros.
- **Reuse, don't duplicate:** reuse the existing `mealSlotForHour` (`src/lib/mealSlot.ts`) and `MealRow`/`foodVisual`/`hslToHex`. Extract the shared `logFood`/`logMeal` into one hook rather than copying it.
- **Cache-share:** the strip's `useMemory` date string must be `new Date().toLocaleDateString("en-CA")` (identical to `app/log.tsx`'s `today()`), so Home and Log share the cached `["memory", date]` query.
- **Tokens-only styling** (no hex literals in components). **RNTL v14:** tests use `await render(...)`.
- **Testing:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` (foreground). Full suite: `npm test -- --ci`.
- **Git:** branch `food-memory`. Single-line conventional commits, no signature. Stage only named files — never `git add -A` (untracked `ios/`, `.superpowers/`, `docs/` exist).

---

### Task 1: `yourUsual` pure selection

**Files:**
- Create: `apps/mobile/src/lib/yourUsual.ts`
- Test: `apps/mobile/src/lib/__tests__/yourUsual.test.ts`

**Interfaces:**
- Consumes: `Memory`, `MemoryFood`, `MemoryMeal` from `@/api/types`; `MealSlot` from `@/lib/mealSlot`.
- Produces:
  - `type UsualRow = { kind: "meal"; meal: MemoryMeal } | { kind: "food"; food: MemoryFood }`
  - `function yourUsual(memory: Memory | undefined, slot: MealSlot): UsualRow[]`

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/lib/__tests__/yourUsual.test.ts`:

```ts
import { yourUsual, type UsualRow } from "../yourUsual";
import type { Memory, MemoryFood, MemoryMeal } from "@/api/types";

function food(id: string, name: string, slot: string): MemoryFood {
  return { food_item_id: id, name, meal_slot: slot, grams: 100, kcal: 100, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
}
function meal(id: string, name: string, slot: string): MemoryMeal {
  return { id, name, meal_slot: slot, items: [food("x", "X", slot)], kcal: 200, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
}
function mem(over: Partial<Memory>): Memory {
  return { recents: [], frequent: [], usual_meals: [], ...over };
}

test("undefined memory returns empty", () => {
  expect(yourUsual(undefined, "breakfast")).toEqual([]);
});

test("meals for the slot come before frequent foods for the slot", () => {
  const m = mem({ usual_meals: [meal("m1", "Oats & Egg", "breakfast")], frequent: [food("f1", "Eggs", "breakfast")] });
  const rows = yourUsual(m, "breakfast");
  expect(rows.map((r) => r.kind)).toEqual(["meal", "food"]);
  expect((rows[0] as Extract<UsualRow, { kind: "meal" }>).meal.id).toBe("m1");
});

test("wrong-slot entries are excluded", () => {
  const m = mem({ usual_meals: [meal("m1", "M", "lunch")], frequent: [food("f1", "F", "lunch")] });
  // no breakfast entries, and no fallback frequent for breakfast -> fallback is overall frequent (the lunch food)
  const rows = yourUsual(m, "breakfast");
  expect(rows).toHaveLength(1); // fallback to overall frequent
  expect(rows[0].kind).toBe("food");
});

test("caps at 4 rows for the slot", () => {
  const m = mem({
    usual_meals: [meal("m1", "M", "dinner"), meal("m2", "M2", "dinner")],
    frequent: [food("f1", "A", "dinner"), food("f2", "B", "dinner"), food("f3", "C", "dinner")],
  });
  expect(yourUsual(m, "dinner")).toHaveLength(4); // 2 meals + first 2 foods
});

test("falls back to overall top frequent when slot has nothing", () => {
  const m = mem({ frequent: [food("f1", "Eggs", "lunch"), food("f2", "Oats", "dinner")] });
  const rows = yourUsual(m, "breakfast");
  expect(rows.map((r) => (r as Extract<UsualRow, { kind: "food" }>).food.food_item_id)).toEqual(["f1", "f2"]);
});

test("returns empty when there is no data at all", () => {
  expect(yourUsual(mem({}), "breakfast")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/lib/__tests__/yourUsual.test.ts`
Expected: FAIL — cannot find module `../yourUsual`.

- [ ] **Step 3: Implement** — `apps/mobile/src/lib/yourUsual.ts`:

```ts
import type { Memory, MemoryFood, MemoryMeal } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";

export type UsualRow =
  | { kind: "meal"; meal: MemoryMeal }
  | { kind: "food"; food: MemoryFood };

const MAX_ROWS = 4;

// yourUsual picks up to 4 one-tap rows for the given meal slot: the user's
// usual MEALS for that slot first, then their frequent single FOODS for that
// slot. If the slot has neither, it falls back to the user's overall top
// frequent foods. Pure function of (memory, slot) — no time, no I/O.
export function yourUsual(memory: Memory | undefined, slot: MealSlot): UsualRow[] {
  if (!memory) return [];
  const meals = memory.usual_meals
    .filter((m) => m.meal_slot === slot)
    .map((meal): UsualRow => ({ kind: "meal", meal }));
  const foods = memory.frequent
    .filter((f) => f.meal_slot === slot)
    .map((food): UsualRow => ({ kind: "food", food }));
  const forSlot = [...meals, ...foods].slice(0, MAX_ROWS);
  if (forSlot.length > 0) return forSlot;
  return memory.frequent.slice(0, MAX_ROWS).map((food): UsualRow => ({ kind: "food", food }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/lib/__tests__/yourUsual.test.ts`
Expected: PASS (all 6) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/yourUsual.ts apps/mobile/src/lib/__tests__/yourUsual.test.ts
git commit -m "feat(mobile): yourUsual slot selection for Home strip"
```

---

### Task 2: Extract `useInstantLog` hook

**Files:**
- Create: `apps/mobile/src/api/useInstantLog.ts`
- Modify: `apps/mobile/app/log.tsx` (replace inline `logFood`/`logMeal` + their hooks with the shared hook)
- Test: `apps/mobile/app/__tests__/log.test.tsx` must stay green (no new test needed here — the strip test in Task 3 covers the hook's call wiring)

**Interfaces:**
- Consumes: `useCreateLog`, `useCreateLogBatch`, `useDeleteLog` from `@/api/hooks`; `useToast` from `@/components/Toast`; `haptics` from `@/motion`; `MemoryFood`, `MemoryMeal` from `@/api/types`.
- Produces: `function useInstantLog(): { logFood: (f: MemoryFood) => void; logMeal: (m: MemoryMeal) => void }`

- [ ] **Step 1: Create the hook** — `apps/mobile/src/api/useInstantLog.ts` (transcribe the exact current behaviour from `app/log.tsx:92-132`):

```ts
import { useCreateLog, useCreateLogBatch, useDeleteLog } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { haptics } from "@/motion";
import type { MemoryFood, MemoryMeal } from "@/api/types";

// useInstantLog centralises the one-tap "log from memory + Undo toast" flow so
// the Log screen and the Home "Your usual" strip share one implementation.
// The client never sends macros — only food_item_id + grams + slot + logged_at;
// nutrition is recomputed server-side.
export function useInstantLog() {
  const createLog = useCreateLog();
  const batchLog = useCreateLogBatch();
  const deleteLog = useDeleteLog();
  const toast = useToast();

  const logFood = (f: MemoryFood) => {
    createLog.mutate(
      {
        food_item_id: f.food_item_id,
        meal_slot: f.meal_slot,
        source: "memory",
        quantity_grams: f.grams,
        logged_at: new Date().toISOString(),
      },
      {
        onSuccess: (created) => {
          haptics.success();
          toast.show({
            message: `Logged ${f.name}`,
            actionLabel: "Undo",
            onAction: () => deleteLog.mutate(created.id),
          });
        },
      },
    );
  };

  const logMeal = (m: MemoryMeal) => {
    batchLog.mutate(
      {
        logged_at: new Date().toISOString(),
        meal_slot: m.meal_slot,
        items: m.items.map((i) => ({ food_item_id: i.food_item_id, quantity_grams: i.grams })),
      },
      {
        onSuccess: (created) => {
          haptics.success();
          toast.show({
            message: `Logged ${m.name}`,
            actionLabel: "Undo",
            onAction: () => created.forEach((l) => deleteLog.mutate(l.id)),
          });
        },
      },
    );
  };

  return { logFood, logMeal };
}
```

- [ ] **Step 2: Update `app/log.tsx` to use the hook.**

In the imports, change the `@/api/hooks` import from
`import { useCreateLog, useCreateLogBatch, useDeleteLog, useFoodSearch, useMemory } from "@/api/hooks";`
to
`import { useCreateLog, useFoodSearch, useMemory } from "@/api/hooks";`
Remove `import { useToast } from "@/components/Toast";`.
Add `import { useInstantLog } from "@/api/useInstantLog";`.
Change `import type { FoodItem, MemoryFood, MemoryMeal } from "@/api/types";` to `import type { FoodItem } from "@/api/types";` (the `MemoryFood`/`MemoryMeal` types are now only referenced inside the hook; the render maps infer their element types).

In the component body, replace these lines:
```tsx
  const createLog = useCreateLog();
  const memory = useMemory(today());
  const batchLog = useCreateLogBatch();
  const deleteLog = useDeleteLog();
  const toast = useToast();
```
with:
```tsx
  const createLog = useCreateLog();
  const memory = useMemory(today());
  const { logFood, logMeal } = useInstantLog();
```
(`createLog` is still used by `submit()`; keep it.)

Then DELETE the two inline functions `function logFood(f: MemoryFood) { ... }` and `function logMeal(m: MemoryMeal) { ... }` (currently `app/log.tsx:92-132`) — they now live in the hook. The JSX call sites `onPress={() => logFood(f)}` / `onPress={() => logMeal(m)}` are unchanged (they now call the hook's functions).

- [ ] **Step 3: Run to verify log.tsx still works**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci app/__tests__/log.test.tsx`
Expected: PASS (all 5 log tests) + tsc clean. (The test mocks `@/api/hooks` and `@/components/Toast`; `useInstantLog` composes those mocks, so the tap-logs-it and batch-logs-it assertions still hit the same mutate spies.)

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/api/useInstantLog.ts apps/mobile/app/log.tsx
git commit -m "refactor(mobile): extract useInstantLog shared hook from log screen"
```

---

### Task 3: `YourUsualStrip` component

**Files:**
- Create: `apps/mobile/src/components/home/YourUsualStrip.tsx`
- Test: `apps/mobile/src/components/home/__tests__/YourUsualStrip.test.tsx`

**Interfaces:**
- Consumes: `useMemory` (`@/api/hooks`), `useInstantLog` (Task 2), `yourUsual` (Task 1), `mealSlotForHour` (`@/lib/mealSlot`), `MealRow`, `GroupedSection`, `Overline`, `foodVisual`, `hslToHex`.
- Produces: `function YourUsualStrip(): JSX.Element | null`

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/components/home/__tests__/YourUsualStrip.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";

const logMeal = jest.fn();
const logFood = jest.fn();
let memoryReturn: any = { data: undefined, isLoading: true, isError: false };

jest.mock("@/api/hooks", () => ({ useMemory: () => memoryReturn }));
jest.mock("@/api/useInstantLog", () => ({ useInstantLog: () => ({ logMeal, logFood }) }));
jest.mock("@/lib/mealSlot", () => ({ mealSlotForHour: () => "breakfast" }));

import { YourUsualStrip } from "../YourUsualStrip";

const meal = { id: "m1", name: "Oats & Egg", meal_slot: "breakfast", items: [{ food_item_id: "o", name: "Oats", meal_slot: "breakfast", grams: 60, kcal: 233, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" }], kcal: 376, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
const food = { food_item_id: "b", name: "Banana", meal_slot: "breakfast", grams: 120, kcal: 107, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 4, last_logged_at: "" };

beforeEach(() => {
  logMeal.mockClear();
  logFood.mockClear();
});

test("renders nothing while loading", async () => {
  memoryReturn = { data: undefined, isLoading: true, isError: false };
  const { toJSON } = await render(<YourUsualStrip />);
  expect(toJSON()).toBeNull();
});

test("renders nothing when there is nothing for the slot", async () => {
  memoryReturn = { data: { recents: [], frequent: [], usual_meals: [] }, isLoading: false, isError: false };
  const { toJSON } = await render(<YourUsualStrip />);
  expect(toJSON()).toBeNull();
});

test("renders the slot title and rows, and taps log them", async () => {
  memoryReturn = { data: { recents: [], frequent: [food], usual_meals: [meal] }, isLoading: false, isError: false };
  const { getByText } = await render(<YourUsualStrip />);
  getByText("Your usual breakfast");
  fireEvent.press(getByText("Oats & Egg"));
  expect(logMeal).toHaveBeenCalledTimes(1);
  fireEvent.press(getByText("Banana"));
  expect(logFood).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/home/__tests__/YourUsualStrip.test.tsx`
Expected: FAIL — cannot find module `../YourUsualStrip`.

- [ ] **Step 3: Implement** — `apps/mobile/src/components/home/YourUsualStrip.tsx`:

```tsx
import { View } from "react-native";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { useMemory } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { yourUsual } from "@/lib/yourUsual";
import { mealSlotForHour } from "@/lib/mealSlot";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// Same local-date convention as app/log.tsx so the ["memory", date] query is
// cache-shared between Home and the Log screen.
function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

// YourUsualStrip: a contextual "one-tap log" section on Home showing the user's
// usual meals/foods for the current meal slot. Renders nothing while loading,
// on error, or when there is nothing to show (keeps Home uncluttered for new
// users and off-hours).
export function YourUsualStrip() {
  const memory = useMemory(today());
  const { logFood, logMeal } = useInstantLog();
  const slot = mealSlotForHour(new Date().getHours());
  const rows = yourUsual(memory.data, slot);

  if (memory.isLoading || memory.isError || rows.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <Overline style={{ marginBottom: 8 }}>{`Your usual ${slot}`}</Overline>
      <GroupedSection elevated>
        {rows.map((row) => {
          if (row.kind === "meal") {
            const m = row.meal;
            const fv = foodVisual(m.name);
            return (
              <MealRow
                key={`meal-${m.id}`}
                name={m.name}
                slot={m.items.map((i) => i.name).join(" · ")}
                kcal={m.kcal}
                iconName={fv.icon}
                tint={hslToHex(fv.hue, 0.5, 0.5)}
                onPress={() => logMeal(m)}
                accessibilityLabel={m.name}
              />
            );
          }
          const f = row.food;
          const fv = foodVisual(f.name);
          return (
            <MealRow
              key={`food-${f.food_item_id}`}
              name={f.name}
              slot={`${Math.round(f.grams)}g`}
              kcal={f.kcal}
              iconName={fv.icon}
              tint={hslToHex(fv.hue, 0.5, 0.5)}
              onPress={() => logFood(f)}
              accessibilityLabel={f.name}
            />
          );
        })}
      </GroupedSection>
    </View>
  );
}
```

(`Overline` uppercases its children via its own styling — passing `"Your usual breakfast"` renders as the uppercase overline, consistent with the "Today's vitals" / "Meals" headers on Home.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/home/__tests__/YourUsualStrip.test.tsx`
Expected: PASS (all 3) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/home/YourUsualStrip.tsx apps/mobile/src/components/home/__tests__/YourUsualStrip.test.tsx
git commit -m "feat(mobile): YourUsualStrip contextual Home section"
```

---

### Task 4: Wire the strip into Home

**Files:**
- Modify: `apps/mobile/app/(tabs)/index.tsx` (import + render `<YourUsualStrip />` before the "Meals" section)
- Test: full mobile suite green

**Interfaces:**
- Consumes: `YourUsualStrip` (Task 3).

- [ ] **Step 1: Add the import** to `apps/mobile/app/(tabs)/index.tsx` (after the other `@/components/home/...` import at line 11):

```tsx
import { YourUsualStrip } from "@/components/home/YourUsualStrip";
```

- [ ] **Step 2: Render it before the "Meals" feed.** The "Meals" section currently starts at `app/(tabs)/index.tsx:187` with:

```tsx
        <Animated.View entering={enter(3)} style={{ paddingHorizontal: 16, marginTop: 8 }}>
          <Overline style={{ marginBottom: 8 }}>Meals</Overline>
```

Insert `<YourUsualStrip />` on its own line immediately BEFORE that `<Animated.View entering={enter(3)} ...>` line. (The strip manages its own padding/margins and renders `null` when empty, so it needs no `Animated.View` wrapper and adds no blank space when hidden.)

- [ ] **Step 3: Run the full suite + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: PASS (all suites) + tsc clean.

- [ ] **Step 4: Commit**

```bash
git add "apps/mobile/app/(tabs)/index.tsx"
git commit -m "feat(mobile): show Your usual strip on Home"
```

---

## Device verification (controller, after all tasks)

Reanimated/native + real data can't be caught by jest. On the sim (Metro `:8091`, `com.tesserix.kora`, demo user seeded with the food-memory session's repeated logs), open Home and confirm: a "YOUR USUAL {slot}" section renders between the vitals and the Meals feed with `MealRow`s (colored food icons); tapping a meal row batch-logs it with the "Logged … — Undo" toast; tapping a food row logs it; Undo removes it; and at a time-of-day with no usual data (or for a fresh user) the section is absent. idb tap = displayed_px × 0.437 (screen 402×874 pts @3x). Chain tap + Undo in one command (toast auto-dismisses in 5s).

## Out of scope (later Phase 2 specs)

Manual pins/favorites; usual-meal naming & editing; the fibre dashboard tile.
