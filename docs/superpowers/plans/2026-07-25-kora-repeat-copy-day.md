# Repeat a meal + Copy a day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-tap "repeat this meal" (lands today) and an empty-day "copy from another day" picker to the Kora mobile app, reusing the already-built backend endpoints.

**Architecture:** Two TanStack Query mutation hooks drive existing REST endpoints (`POST /v1/logs/:id/repeat`, `POST /v1/logs/copy-day`). Repeat is a bordered icon-square in the meal detail sheet; copy-a-day is a moss text CTA in the Diary empty state that opens a new `CopyDaySheet` bottom sheet listing recent source days.

**Tech Stack:** React Native / Expo (SDK 57), expo-router, TanStack React Query v5, Jest + React Native Testing Library v14, TypeScript.

## Global Constraints

- Mobile suite must stay green: `npx tsc --noEmit` and `npm test -- --ci` (currently 142/142). Run tests in the FOREGROUND.
- Jest `jest.mock` factories may reference only `mock`-prefixed outer variables (hoisting rule).
- No backend changes — both endpoints already exist and are tested.
- Conventional single-line commit messages, no signature.
- Copy is offered only on an empty viewed day; repeat always lands today (now).
- All failure paths must be visible (inline text or Alert) — no silent catches.
- Run all commands from `apps/mobile/` unless noted.

---

### Task 1: Data layer — `useRepeatLog` hook + typed `useCopyDay`

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts` (add `useRepeatLog`; type `useCopyDay` return)
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (unwraps `{data}` envelope), `useMutation`/`useQueryClient`, `FoodLog` type — all already imported in `hooks.ts`.
- Produces:
  - `useRepeatLog(): UseMutationResult<FoodLog, unknown, string>` — `mutate(id)` POSTs `/v1/logs/${id}/repeat` with no body.
  - `useCopyDay()` mutation now resolves to `{ copied: number }` (call sites can read `data.copied` in per-call `onSuccess`).

- [ ] **Step 1: Write the failing test** — append to `apps/mobile/src/api/__tests__/hooks.test.tsx`. Add `useRepeatLog` to the existing import block from `"../hooks"`, then add:

```tsx
test("useRepeatLog POSTs /v1/logs/:id/repeat with no body", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log2" });
  const { result } = await renderHook(() => useRepeatLog(), { wrapper });
  result.current.mutate("log1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log1/repeat", { method: "POST" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci hooks.test`
Expected: FAIL — `useRepeatLog` is not exported (TypeScript/import error).

- [ ] **Step 3: Write minimal implementation** — in `apps/mobile/src/api/hooks.ts`, add `useRepeatLog` immediately after `useCopyDay`, and add the return-type cast to `useCopyDay`'s `mutationFn`.

New hook:

```ts
export function useRepeatLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/logs/${id}/repeat`, { method: "POST" }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

Change `useCopyDay`'s `mutationFn` line from:

```ts
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }),
```

to:

```ts
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }) as Promise<{ copied: number }>,
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `npm test -- --ci hooks.test && npx tsc --noEmit`
Expected: PASS (new test green; no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): add useRepeatLog hook + type useCopyDay result"
```

---

### Task 2: Repeat action in the meal detail sheet

**Files:**
- Modify: `apps/mobile/src/components/Icon.tsx` (register `repeat` glyph)
- Modify: `apps/mobile/app/meal.tsx` (repeat button + Alert + busy gate)
- Test: `apps/mobile/app/__tests__/meal.test.tsx`

**Interfaces:**
- Consumes: `useRepeatLog` from Task 1; `Icon` (name `"repeat"`); `Alert`, `router.back`.
- Produces: a "Repeat entry"-labelled control in the meal sheet action row.

- [ ] **Step 1: Write the failing test** — edit `apps/mobile/app/__tests__/meal.test.tsx`.

Add a repeat mock alongside the existing ones. Change the top mock block so it reads:

```tsx
const mockEditMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
const mockBack = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: () => mockBack() },
  useLocalSearchParams: () => ({
    id: "log1", name: "Brown rice", mealSlot: "breakfast", time: "8:00 AM",
    kcal: "300", protein: "6", carbs: "64", fat: "2", grams: "200",
  }),
}));

jest.mock("@/api/hooks", () => ({
  useEditLog: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: false }),
}));

beforeEach(() => { mockEditMutate.mockClear(); mockDeleteMutate.mockClear(); mockRepeatMutate.mockClear(); mockBack.mockClear(); });
```

Then append this test:

```tsx
test("Repeat calls useRepeatLog, navigates back and confirms", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockRepeatMutate.mockImplementation((_id, opts) => opts.onSuccess?.());
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Repeat entry"));
  expect(mockRepeatMutate).toHaveBeenCalledWith(
    "log1",
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(mockBack).toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalled();
  alertSpy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci meal.test`
Expected: FAIL — no element labelled "Repeat entry" (and `useRepeatLog` not yet consumed).

- [ ] **Step 3a: Register the `repeat` glyph** — in `apps/mobile/src/components/Icon.tsx`, add `Repeat` to the lucide import line and `repeat: Repeat` to `MAP`.

Change the import (add `Repeat` to the existing list):

```tsx
  X, Images, ScanBarcode, Type, Loader, Barcode, ArrowUp, Repeat,
  type LucideIcon,
} from "lucide-react-native";
```

Add to `MAP` (e.g. after the `barcode`/`arrow-up` entries):

```tsx
  barcode: Barcode, "arrow-up": ArrowUp, repeat: Repeat,
```

- [ ] **Step 3b: Add the repeat action** — in `apps/mobile/app/meal.tsx`:

Add the hook import — change the hooks import line to:

```tsx
import { useEditLog, useDeleteLog, useRepeatLog, type EditLogInput } from "@/api/hooks";
```

Inside the component, after `const deleteLog = useDeleteLog();` add:

```tsx
  const repeatLog = useRepeatLog();
```

Extend `busy`:

```tsx
  const busy = editLog.isPending || deleteLog.isPending || repeatLog.isPending;
```

Add the handler after `onDelete`:

```tsx
  const onRepeat = () => {
    if (busy) return;
    setErr(null);
    repeatLog.mutate(p.id, {
      onSuccess: () => {
        router.back();
        Alert.alert("Logged again", "Added to today's diary.");
      },
      onError: () => setErr("Couldn't repeat. Try again."),
    });
  };
```

In the action row, insert the repeat button between the delete `Pressable` and the `Button`:

```tsx
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Repeat entry"
            disabled={busy}
            onPress={onRepeat}
            style={{ width: 48, height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
          >
            <Icon name="repeat" size={18} color={colors.foreground} />
          </Pressable>
```

- [ ] **Step 4: Run test + typecheck + full suite**

Run: `npm test -- --ci meal.test && npx tsc --noEmit`
Expected: PASS (new + existing meal tests green; no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/Icon.tsx apps/mobile/app/meal.tsx apps/mobile/app/__tests__/meal.test.tsx
git commit -m "feat(mobile): repeat-a-meal action in the meal detail sheet"
```

---

### Task 3: `CopyDaySheet` source-day picker

**Files:**
- Create: `apps/mobile/src/components/diary/CopyDaySheet.tsx`
- Test: `apps/mobile/src/components/diary/__tests__/CopyDaySheet.test.tsx`

**Interfaces:**
- Consumes: `useCopyDay` (Task 1, resolves `{ copied: number }`); shared `Sheet`, `AppText`, `Overline`, `useTheme`.
- Produces: `CopyDaySheet({ visible, targetDate, onClose })` — a bottom sheet whose chips are labelled `Copy from ${iso}`.

- [ ] **Step 1: Write the failing test** — create `apps/mobile/src/components/diary/__tests__/CopyDaySheet.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { CopyDaySheet } from "../CopyDaySheet";

const mockCopyMutate = jest.fn();
jest.mock("@/api/hooks", () => ({ useCopyDay: () => ({ mutate: mockCopyMutate, isPending: false }) }));
beforeEach(() => mockCopyMutate.mockClear());

const iso = (d: Date) => d.toLocaleDateString("en-CA");

test("excludes the target day from the source chips", async () => {
  const target = iso(new Date());
  const { queryByLabelText } = await render(
    <CopyDaySheet visible targetDate={target} onClose={jest.fn()} />,
  );
  expect(queryByLabelText(`Copy from ${target}`)).toBeNull();
});

test("picking a day copies from it into the target and closes on copied>0", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 3 }));
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(mockCopyMutate).toHaveBeenCalledWith(
    { from: expect.any(String), to: "2000-01-01" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(onClose).toHaveBeenCalled();
});

test("copied:0 keeps the sheet open with an inline message", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 0 }));
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(await findByText("That day had nothing to copy.")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test("copy error shows an inline message", async () => {
  mockCopyMutate.mockImplementation((_input, opts) => opts.onError?.());
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(await findByText("Couldn't copy. Try again.")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci CopyDaySheet`
Expected: FAIL — `../CopyDaySheet` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `apps/mobile/src/components/diary/CopyDaySheet.tsx`:

```tsx
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCopyDay } from "@/api/hooks";
import { useTheme } from "@/theme";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => d.toLocaleDateString("en-CA");

interface CopyDaySheetProps {
  visible: boolean;
  targetDate: string;
  onClose: () => void;
}

// The seven most recent days ending today, minus the target day itself.
function recentDays(targetDate: string): Date[] {
  const today = new Date();
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (iso(d) !== targetDate) days.push(d);
  }
  return days;
}

export function CopyDaySheet({ visible, targetDate, onClose }: CopyDaySheetProps) {
  const { colors, radius } = useTheme();
  const [msg, setMsg] = useState<string | null>(null);
  const copyDay = useCopyDay();
  const days = recentDays(targetDate);

  const onPick = (from: string) => {
    setMsg(null);
    copyDay.mutate(
      { from, to: targetDate },
      {
        onSuccess: (res) => {
          if (res.copied > 0) onClose();
          else setMsg("That day had nothing to copy.");
        },
        onError: () => setMsg("Couldn't copy. Try again."),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Copy a day</Overline>
        <AppText muted style={{ fontSize: 12, marginTop: 6, marginBottom: 16 }}>
          Pick a day to copy into {targetDate}.
        </AppText>
        <View style={{ gap: 8 }}>
          {days.map((d) => {
            const dISO = iso(d);
            return (
              <Pressable
                key={dISO}
                accessibilityRole="button"
                accessibilityLabel={`Copy from ${dISO}`}
                disabled={copyDay.isPending}
                onPress={() => onPick(dISO)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: copyDay.isPending ? 0.5 : 1 }}
              >
                <AppText style={{ fontSize: 15, fontWeight: "600" }}>{DOW[d.getDay()]}</AppText>
                <AppText muted style={{ fontSize: 13 }}>{dISO}</AppText>
              </Pressable>
            );
          })}
        </View>
        {msg ? <AppText style={{ color: colors.destructive, marginTop: 14 }}>{msg}</AppText> : null}
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npm test -- --ci CopyDaySheet && npx tsc --noEmit`
Expected: PASS (4 tests green; no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/diary/CopyDaySheet.tsx apps/mobile/src/components/diary/__tests__/CopyDaySheet.test.tsx
git commit -m "feat(mobile): CopyDaySheet source-day picker"
```

---

### Task 4: Wire the copy-a-day CTA into the Diary empty state

**Files:**
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (empty-state CTA + conditional sheet mount)
- Create: `apps/mobile/app/__tests__/diary-copy.test.tsx` (empty-day CTA renders + opens sheet)
- Modify: `apps/mobile/app/(tabs)/__tests__/diary.test.tsx` (non-empty day hides the CTA)

**Interfaces:**
- Consumes: `CopyDaySheet` (Task 3); existing `useState`, `selected`, `logged`.
- Produces: a "Copy from another day" CTA visible only when `logged.length === 0`.

- [ ] **Step 1: Write the failing tests.**

Create `apps/mobile/app/__tests__/diary-copy.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import Diary from "../(tabs)/diary";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const mockCopyMutate = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 0 }, targets: { kcal: 2000 }, water_ml: 0 } }),
  useDayLogs: () => ({ data: [] }),
  useAddWater: () => ({ mutate: jest.fn(), isPending: false }),
  useCopyDay: () => ({ mutate: mockCopyMutate, isPending: false }),
}));

test("empty day shows the Copy-from-another-day CTA and it opens the picker", async () => {
  const { getByText, findByText } = await render(<Diary />);
  expect(getByText("Copy from another day")).toBeTruthy();
  await fireEvent.press(getByText("Copy from another day"));
  expect(await findByText("Copy a day")).toBeTruthy();
});
```

In `apps/mobile/app/(tabs)/__tests__/diary.test.tsx` (which mocks a NON-empty `useDayLogs`), append:

```tsx
test("a day with logs does not show the Copy CTA", async () => {
  const { queryByText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon"); // ensure render settled
  expect(queryByText("Copy from another day")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --ci diary`
Expected: FAIL — no "Copy from another day" text yet (diary-copy fails; the new diary.test assertion passes trivially but keep it — it locks the behavior).

- [ ] **Step 3: Write minimal implementation** — in `apps/mobile/app/(tabs)/diary.tsx`:

Add the import near the other component imports:

```tsx
import { CopyDaySheet } from "@/components/diary/CopyDaySheet";
```

Add state next to the other `useState` hooks (e.g. after `const [waterErr, setWaterErr] = useState<string | null>(null);`):

```tsx
  const [copyOpen, setCopyOpen] = useState(false);
```

Replace the empty-state line:

```tsx
          {logged.length === 0 ? <AppText muted style={{ paddingVertical: 12 }}>Nothing logged this day.</AppText> : null}
```

with:

```tsx
          {logged.length === 0 ? (
            <View style={{ paddingVertical: 12 }}>
              <AppText muted>Nothing logged this day.</AppText>
              <Pressable accessibilityRole="button" onPress={() => setCopyOpen(true)} style={{ marginTop: 8 }}>
                <AppText style={{ color: colors.primary, fontWeight: "600" }}>Copy from another day</AppText>
              </Pressable>
            </View>
          ) : null}
```

Wrap the returned `ScrollView` in a fragment and mount the sheet conditionally as a sibling. Change the opening of the return from:

```tsx
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
```

to:

```tsx
  return (
    <>
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
```

and change the closing of the return from:

```tsx
    </ScrollView>
  );
}
```

to:

```tsx
    </ScrollView>
    {copyOpen ? <CopyDaySheet visible targetDate={selected} onClose={() => setCopyOpen(false)} /> : null}
    </>
  );
}
```

(`Pressable` and `View` are already imported in `diary.tsx`.)

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npm test -- --ci diary && npx tsc --noEmit && npm test -- --ci`
Expected: PASS — diary-copy + diary tests green; whole mobile suite green (was 142, now higher).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/\(tabs\)/diary.tsx apps/mobile/app/__tests__/diary-copy.test.tsx apps/mobile/app/\(tabs\)/__tests__/diary.test.tsx
git commit -m "feat(mobile): copy-a-day CTA in the Diary empty state"
```

---

## Final verification (after all tasks)

- [ ] `cd apps/mobile && npx tsc --noEmit` — clean.
- [ ] `cd apps/mobile && npm test -- --ci` — whole suite green.
- [ ] Final whole-branch review of the feature commits (Task 1..4) on opus before the feature is declared READY TO MERGE.
- [ ] Do NOT push until the user approves.
