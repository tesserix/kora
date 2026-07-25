# Log Edit/Delete + Quick-Add Water Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Kora mobile app UI to edit a logged food's portion/meal-slot, delete a log, and quick-add water — all against endpoints that already exist server-side.

**Architecture:** Four independent tasks: (1) React Query mutation hooks + the water-hook extension, (2) a reusable `Stepper`, (3) the editable meal-detail screen wired to the hooks, (4) Diary water quick-add buttons. No backend changes.

**Tech Stack:** Expo SDK 57, expo-router, React 19, @tanstack/react-query v5, @testing-library/react-native **v14 (async `render`/`fireEvent` — always `await`)**, TypeScript strict, jest.

## Global Constraints

- **Invariant:** the client sends only `quantity_grams` and/or `meal_slot` on an edit — **never** a nutrition number. The stepper may scale the *displayed* kcal/macros locally for preview (`display = base × grams / baseGrams`); the *saved* values come from the server's row-sourced recompute.
- No `any` in app code; use `unknown`/generics. No `console.log`. Prop shapes use `interface` or named `type`; callback props typed explicitly.
- Immutability — never mutate state objects/arrays; return new copies.
- Error handling — every mutation failure surfaces a visible message; never a silent failure.
- `MealSlot = "breakfast" | "lunch" | "dinner" | "snack"` is imported from `@/lib/mealSlot`.
- `apiFetch(path, init?)` sets JSON headers + auth and returns `body.data ?? body`. Mutations cast its result.
- Query keys: day logs = `["logs", date]`, dashboard = `["dashboard", date]`; invalidate by prefix (`["logs"]`, `["dashboard"]`) exactly like `useCreateLog`.
- Run tests FOREGROUND from `apps/mobile/`: `npx tsc --noEmit` then `npm test -- --ci`. Conventional single-line commits, no signature.

---

### Task 1: API hooks — edit, delete, water-with-date

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces: `useEditLog()` (mutate `EditLogInput = { id: string; meal_slot?: MealSlot; quantity_grams?: number }` → `Promise<FoodLog>`); `useDeleteLog()` (mutate `id: string`); `useAddWater()` (mutate `{ volume_ml: number; logged_at?: string }`).
- Consumes: existing `apiFetch`, `useMutation`, `useQueryClient`, `FoodLog`, and `MealSlot` from `@/lib/mealSlot`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/api/__tests__/hooks.test.tsx` (the file already mocks `@/lib/api` and defines `wrapper` + a `resolution`/fixtures; reuse them). Add these three tests:

```tsx
import { useEditLog, useDeleteLog, useAddWater } from "../hooks";

test("useEditLog PATCHes /v1/logs/:id with only the patch fields and invalidates logs+dashboard", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log1" });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  result.current.mutate({ id: "log1", quantity_grams: 120, meal_slot: "lunch" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log1", {
    method: "PATCH",
    body: JSON.stringify({ quantity_grams: 120, meal_slot: "lunch" }),
  });
});

test("useDeleteLog DELETEs /v1/logs/:id", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ deleted: true });
  const { result } = await renderHook(() => useDeleteLog(), { wrapper });
  result.current.mutate("log9");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log9", { method: "DELETE" });
});

test("useAddWater POSTs /v1/water with volume_ml and logged_at", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({});
  const { result } = await renderHook(() => useAddWater(), { wrapper });
  result.current.mutate({ volume_ml: 250, logged_at: "2026-07-25T12:00:00Z" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/water", {
    method: "POST",
    body: JSON.stringify({ volume_ml: 250, logged_at: "2026-07-25T12:00:00Z" }),
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `cd apps/mobile && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useEditLog`/`useDeleteLog` are not exported; `useAddWater` is called with a number, not an object.

- [ ] **Step 3: Implement**

In `apps/mobile/src/api/hooks.ts`, add the `MealSlot` type import at the top (with the other imports):

```ts
import type { MealSlot } from "@/lib/mealSlot";
```

Replace the existing `useAddWater` with the object-input version, and add the two new hooks after it:

```ts
export function useAddWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ volume_ml, logged_at }: { volume_ml: number; logged_at?: string }) =>
      apiFetch("/v1/water", { method: "POST", body: JSON.stringify({ volume_ml, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

export type EditLogInput = {
  id: string;
  meal_slot?: MealSlot;
  quantity_grams?: number;
};

export function useEditLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: EditLogInput) =>
      apiFetch(`/v1/logs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDeleteLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/logs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

Note: when `logged_at` is `undefined`, `JSON.stringify({ volume_ml, logged_at })` omits it, so the backend defaults `logged_at` to now — the water test always passes it, so the serialized string is deterministic.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: tsc clean; the three new tests PASS (plus the file's existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): add useEditLog/useDeleteLog hooks + water logged_at"
```

---

### Task 2: Reusable `Stepper` component

**Files:**
- Create: `apps/mobile/src/components/Stepper.tsx`
- Test: `apps/mobile/src/components/__tests__/Stepper.test.tsx`

**Interfaces:**
- Produces: `Stepper` — `interface StepperProps { value: number; onChange: (next: number) => void; step?: number; min?: number }`. Minus/plus buttons clamp at `min` (default 0), step default 10. Pure: computes `next` and calls `onChange(next)`; never mutates.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/Stepper.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { Stepper } from "../Stepper";

test("increments by step and decrements clamped at min", async () => {
  const onChange = jest.fn();
  const { getByLabelText, rerender } = await render(<Stepper value={100} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Increase"));
  expect(onChange).toHaveBeenLastCalledWith(110);

  await rerender(<Stepper value={10} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Decrease"));
  expect(onChange).toHaveBeenLastCalledWith(10); // clamped, not 0
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/__tests__/Stepper.test.tsx`
Expected: FAIL — `../Stepper` not found.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/components/Stepper.tsx`:

```tsx
import { Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
}

export function Stepper({ value, onChange, step = 10, min = 0 }: StepperProps) {
  const { colors, radius, fonts } = useTheme();
  const btn = {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Decrease" onPress={() => onChange(Math.max(min, value - step))} style={btn}>
        <Icon name="minus" size={14} color={colors.foreground} />
      </Pressable>
      <AppText style={{ minWidth: 56, textAlign: "center", fontFamily: fonts.mono, fontSize: 15, fontWeight: "600" }}>{value} g</AppText>
      <Pressable accessibilityRole="button" accessibilityLabel="Increase" onPress={() => onChange(value + step)} style={btn}>
        <Icon name="plus" size={14} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/__tests__/Stepper.test.tsx`
Expected: tsc clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/Stepper.tsx apps/mobile/src/components/__tests__/Stepper.test.tsx
git commit -m "feat(mobile): add reusable Stepper component"
```

---

### Task 3: Editable meal detail + `openMeal` params

**Files:**
- Modify: `apps/mobile/app/meal.tsx` (make editable)
- Modify: `apps/mobile/app/(tabs)/index.tsx` (openMeal passes `id` + `grams`)
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (openMeal passes `id` + `grams`)
- Test: `apps/mobile/app/__tests__/meal.test.tsx` (new)

**Interfaces:**
- Consumes: `useEditLog`, `useDeleteLog` (Task 1); `Stepper` (Task 2); `MealSlot` from `@/lib/mealSlot`.
- Route params (`meal.tsx`): `{ id, name, mealSlot, time, kcal, protein, carbs, fat, grams }` (all strings).

- [ ] **Step 1: Add `id` + `grams` to both `openMeal` calls**

In `apps/mobile/app/(tabs)/index.tsx`, the `openMeal` function currently builds `params` with `name, mealSlot, time, kcal, protein, carbs, fat`. Add two entries: `id: log.id, grams: String(Math.round(log.quantity_grams))`.

In `apps/mobile/app/(tabs)/diary.tsx` line ~48-49, do the same: add `id: log.id, grams: String(Math.round(log.quantity_grams))` to the `params` object.

- [ ] **Step 2: Write the failing test**

Create `apps/mobile/app/__tests__/meal.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import MealDetail from "../meal";

const editMutate = jest.fn();
const deleteMutate = jest.fn();
const backMock = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: () => backMock() },
  useLocalSearchParams: () => ({
    id: "log1", name: "Brown rice", mealSlot: "breakfast", time: "8:00 AM",
    kcal: "300", protein: "6", carbs: "64", fat: "2", grams: "200",
  }),
}));

jest.mock("@/api/hooks", () => ({
  useEditLog: () => ({ mutate: editMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: deleteMutate, isPending: false }),
}));

beforeEach(() => { editMutate.mockClear(); deleteMutate.mockClear(); backMock.mockClear(); });

test("Save is disabled until something changes, then PATCHes only changed fields", async () => {
  const { getByText, getByLabelText } = await render(<MealDetail />);
  // clean form: Save disabled -> pressing it does not mutate
  await fireEvent.press(getByText("Save changes"));
  expect(editMutate).not.toHaveBeenCalled();
  // bump grams 200 -> 210 and move to lunch
  await fireEvent.press(getByLabelText("Increase"));
  await fireEvent.press(getByText("Lunch"));
  await fireEvent.press(getByText("Save changes"));
  expect(editMutate).toHaveBeenCalledWith(
    { id: "log1", quantity_grams: 210, meal_slot: "lunch" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("Delete confirms then calls useDeleteLog", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
    // press the destructive "Delete" button
    const del = (buttons ?? []).find((b) => b.style === "destructive");
    del?.onPress?.();
  });
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Delete entry"));
  expect(deleteMutate).toHaveBeenCalledWith("log1", expect.objectContaining({ onSuccess: expect.any(Function) }));
  alertSpy.mockRestore();
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `cd apps/mobile && npm test -- --ci app/__tests__/meal.test.tsx`
Expected: FAIL — current `meal.tsx` has no "Save changes"/"Lunch"/stepper/"Delete entry".

- [ ] **Step 4: Implement the editable screen**

Replace `apps/mobile/app/meal.tsx` with:

```tsx
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { FoodTile } from "@/components/FoodTile";
import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useEditLog, useDeleteLog, type EditLogInput } from "@/api/hooks";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";

const SLOTS: ReadonlyArray<MealSlot> = ["breakfast", "lunch", "dinner", "snack"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function MealDetail() {
  const { colors, radius, fonts } = useTheme();
  const p = useLocalSearchParams<{
    id: string; name: string; mealSlot: string; time: string;
    kcal: string; protein: string; carbs: string; fat: string; grams: string;
  }>();
  const name = p.name ?? "Meal";
  const vis = foodVisual(name, p.mealSlot);
  const baseGrams = Number(p.grams) || 0;
  const baseKcal = Number(p.kcal) || 0;

  const [grams, setGrams] = useState(baseGrams);
  const [slot, setSlot] = useState<MealSlot>((p.mealSlot as MealSlot) ?? "breakfast");
  const [err, setErr] = useState<string | null>(null);

  const editLog = useEditLog();
  const deleteLog = useDeleteLog();
  const busy = editLog.isPending || deleteLog.isPending;

  const scale = (base: number) => (baseGrams > 0 ? Math.round(base * grams / baseGrams) : base);
  const kcal = scale(baseKcal);
  const dirty = grams !== baseGrams || slot !== p.mealSlot;

  const tiles: ReadonlyArray<readonly [string, number, number]> = [
    ["Protein", scale(Number(p.protein) || 0), MACRO.protein.hue],
    ["Carbs", scale(Number(p.carbs) || 0), MACRO.carbs.hue],
    ["Fat", scale(Number(p.fat) || 0), MACRO.fat.hue],
  ];

  const onSave = () => {
    if (!dirty || busy) return;
    setErr(null);
    const patch: EditLogInput = { id: p.id };
    if (grams !== baseGrams) patch.quantity_grams = grams;
    if (slot !== p.mealSlot) patch.meal_slot = slot;
    editLog.mutate(patch, {
      onSuccess: () => router.back(),
      onError: () => setErr("Couldn't save changes. Try again."),
    });
  };

  const onDelete = () => {
    if (busy) return;
    Alert.alert("Delete this entry?", "This removes it from your diary.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteLog.mutate(p.id, {
            onSuccess: () => router.back(),
            onError: () => setErr("Couldn't delete. Try again."),
          }),
      },
    ]);
  };

  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <Overline>{name} · {p.time}</Overline>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
              <Numeral size={24}>{String(kcal)}</Numeral>
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 14 }}>kcal</AppText>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginBottom: 18 }}>
          {tiles.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{`${value}g`}</Numeral>
            </View>
          ))}
        </View>

        <Overline>Portion</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, marginTop: 6 }}>
          <AppText style={{ fontSize: 14, fontWeight: "600" }}>{name}</AppText>
          <Stepper value={grams} onChange={setGrams} step={10} min={10} />
        </View>

        <Overline style={{ marginTop: 8 }}>Meal</Overline>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 20 }}>
          {SLOTS.map((s) => {
            const on = s === slot;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setSlot(s)}
                style={{ flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.md, borderWidth: on ? 0 : 1, borderColor: colors.border, backgroundColor: on ? colors.primary : colors.card }}
              >
                <AppText style={{ fontSize: 12, fontWeight: "600", color: on ? colors.primaryForeground : colors.foreground }}>{cap(s)}</AppText>
              </Pressable>
            );
          })}
        </View>

        {err ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{err}</AppText> : null}

        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete entry"
            disabled={busy}
            onPress={onDelete}
            style={{ width: 48, height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
          >
            <Icon name="trash-2" size={18} color={colors.destructive} />
          </Pressable>
          <Button title="Save changes" onPress={onSave} disabled={!dirty || busy} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci app/__tests__/meal.test.tsx`
Expected: tsc clean; both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/meal.tsx "apps/mobile/app/(tabs)/index.tsx" "apps/mobile/app/(tabs)/diary.tsx" apps/mobile/app/__tests__/meal.test.tsx
git commit -m "feat(mobile): editable meal detail — portion stepper, meal slot, delete"
```

---

### Task 4: Diary quick-add water

**Files:**
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (water quick-add buttons)
- Test: `apps/mobile/app/__tests__/diary-water.test.tsx` (new)

**Interfaces:**
- Consumes: `useAddWater` (Task 1, object input). The Diary already has `selected` (ISO `YYYY-MM-DD`) in scope.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/diary-water.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import Diary from "../(tabs)/diary";

const addWaterMutate = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 0 }, targets: { kcal: 2000 }, water_ml: 500 } }),
  useDayLogs: () => ({ data: [] }),
  useAddWater: () => ({ mutate: addWaterMutate, isPending: false }),
}));

beforeEach(() => addWaterMutate.mockClear());

test("tapping +250 ml logs 250 for the selected day at noon UTC", async () => {
  const { getByText } = await render(<Diary />);
  await fireEvent.press(getByText("+250 ml"));
  const [arg] = addWaterMutate.mock.calls[0];
  expect(arg.volume_ml).toBe(250);
  expect(arg.logged_at).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00Z$/); // noon-UTC of the selected day
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd apps/mobile && npm test -- --ci app/__tests__/diary-water.test.tsx`
Expected: FAIL — no "+250 ml" control; `useAddWater` not imported in diary.

- [ ] **Step 3: Implement**

In `apps/mobile/app/(tabs)/diary.tsx`:

1. Add `useAddWater` to the hooks import:
```ts
import { useDashboard, useDayLogs, useAddWater } from "@/api/hooks";
```
2. Add the mutation + a handler inside the `Diary` component, after `const logs = useDayLogs(selected);`:
```ts
  const addWater = useAddWater();
  const [waterErr, setWaterErr] = useState<string | null>(null);
  const addWaterMl = (volume_ml: number) => {
    setWaterErr(null);
    addWater.mutate(
      { volume_ml, logged_at: `${selected}T12:00:00Z` },
      { onError: () => setWaterErr("Couldn't add water. Try again.") },
    );
  };
```
3. Under the stats `Card` (right after its closing `</Card>`), add a water quick-add row. (No icon — the "Add water" label + pills are enough; `droplet` is not in the curated `Icon` map, so avoid it. `radius.full` (9999) exists in the theme.)
```tsx
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <AppText muted style={{ fontSize: 12, marginRight: "auto" }}>Add water</AppText>
          {[250, 500].map((ml) => (
            <Pressable
              key={ml}
              accessibilityRole="button"
              accessibilityLabel={`Add ${ml} ml water`}
              disabled={addWater.isPending}
              onPress={() => addWaterMl(ml)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: addWater.isPending ? 0.5 : 1 }}
            >
              <AppText style={{ fontSize: 12, fontWeight: "600", color: colors.primary }}>{`+${ml} ml`}</AppText>
            </Pressable>
          ))}
        </View>
        {waterErr ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{waterErr}</AppText> : null}
```
`Pressable` is already imported in `diary.tsx`; no new component import is needed for this row.

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci app/__tests__/diary-water.test.tsx`
Expected: tsc clean; PASS.

- [ ] **Step 5: Full suite + commit**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: all suites green.

```bash
git add "apps/mobile/app/(tabs)/diary.tsx" apps/mobile/app/__tests__/diary-water.test.tsx
git commit -m "feat(mobile): quick-add water on Diary (+250/+500 ml)"
```

---

## Verification (whole feature)

- `cd apps/mobile && npx tsc --noEmit` clean; `npm test -- --ci` all green.
- Live (optional, rig already up): open a logged meal → adjust grams (kcal updates live) → move meal slot → Save → Home/Diary reflect it; open again → Delete → confirm → gone. On Diary, tap +250 ml → Water stat rises. Confirm the displayed edit never posts a nutrition number (only `quantity_grams`/`meal_slot` in the PATCH body).
