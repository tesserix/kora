# Reminders in Settings and Weight Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a notifications entry where users look for it, and add a weight check-in reminder that doesn't nag about a weigh-in you already did.

**Architecture:** Meal and custom reminders use repeating OS triggers, which cannot be conditionally suppressed. The weight reminder therefore uses a one-shot `DATE` trigger whose next fire is computed by a pure function and recomputed on app foreground and after a weight is logged. Because `applyAllReminders` cancels *all* scheduled notifications, it must own the weight reminder too rather than letting it be scheduled alongside.

**Tech Stack:** Expo (SDK 57) / React Native / TypeScript, expo-notifications, AsyncStorage, jest, @testing-library/react-native

**Spec:** `docs/superpowers/specs/2026-08-10-kora-reminders-design.md`

## Global Constraints

- `applyAllReminders` begins with `Notifications.cancelAllScheduledNotificationsAsync()` (`src/reminders/schedule.ts:72`). **Anything scheduled outside it is destroyed on the next call.** The weight reminder must be scheduled *by* it.
- `MAX_SCHEDULED_NOTIFICATIONS = 60` (below iOS's 64, past which requests are silently dropped). Meals are scheduled first and must keep winning; the weight reminder counts against the same budget.
- Pure scheduling logic imports **no** Expo modules, so it stays table-testable — the existing `buildSchedule` / `buildCustomSchedule` follow this and the new code must too.
- Prefs loading never throws: fall back to defaults on a missing or unparseable value, exactly as `loadPrefs` does (`src/reminders/prefs.ts:19`).
- Permission denial must revert the toggle, as `useReminderPrefs.setSlot` already does.
- A failed weight fetch during reconciliation is treated as **no recent weigh-in**, so the reminder fires. A redundant reminder is a nuisance; a suppressed one defeats the feature.
- Weight reminder default: **disabled**, 07:00, Mondays only.
- `apps/mobile/AGENTS.md` requires reading https://docs.expo.dev/versions/v57.0.0/ before writing Expo code.
- Tests run from `apps/mobile/` via `npx jest`; typecheck with `npx tsc --noEmit`.
- Commits: conventional, **single-line**, no signature or attribution.

**Context worth knowing:** `CustomReminderSheet` already ships a `"Weigh-in"` preset (`src/components/reminders/CustomReminderSheet.tsx:15`), so a *dumb* weigh-in reminder is already one tap away. The only genuinely new capability here is skipping when the user has already weighed in.

---

### Task 1: Extract `WeekdayPicker`

**Files:**
- Create: `apps/mobile/src/components/reminders/WeekdayPicker.tsx`
- Modify: `apps/mobile/src/components/reminders/CustomReminderSheet.tsx:11-14` (DAY_CHIPS), `:58-59` (toggleDay), `:115-126` (chips JSX)
- Test: `apps/mobile/src/components/reminders/__tests__/WeekdayPicker.test.tsx`

**Interfaces:**
- Consumes: `Weekday` from `@/reminders/customPrefs`
- Produces: `export function WeekdayPicker({ days, onChange }: { days: Weekday[]; onChange: (days: Weekday[]) => void }): ReactElement`

- [ ] **Step 1: Write the failing test**

```typescript
import { fireEvent } from "@testing-library/react-native";
import { render } from "@/test/render";
import { WeekdayPicker } from "../WeekdayPicker";

test("tapping an unselected day adds it, in sorted order", async () => {
  const onChange = jest.fn();
  const { getByTestId } = await render(<WeekdayPicker days={[3]} onChange={onChange} />);

  await fireEvent.press(getByTestId("day-1"));

  expect(onChange).toHaveBeenCalledWith([1, 3]);
});

test("tapping a selected day removes it", async () => {
  const onChange = jest.fn();
  const { getByTestId } = await render(<WeekdayPicker days={[1, 3]} onChange={onChange} />);

  await fireEvent.press(getByTestId("day-3"));

  expect(onChange).toHaveBeenCalledWith([1]);
});

test("every day selects all seven", async () => {
  const onChange = jest.fn();
  const { getByText } = await render(<WeekdayPicker days={[1]} onChange={onChange} />);

  await fireEvent.press(getByText("Every day"));

  expect(onChange).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5, 6]);
});
```

If `@/test/render` does not exist, use whichever render helper the neighbouring reminder tests already use — check `src/components/settings/__tests__/RemindersSection.test.tsx` first.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/reminders/__tests__/WeekdayPicker.test.tsx`
Expected: FAIL — cannot resolve `../WeekdayPicker`.

- [ ] **Step 3: Implement**

Move `DAY_CHIPS`, `ALL`, the `toggleDay` logic, the chips JSX (`CustomReminderSheet.tsx:115-126`) and the "Every day" pressable into the new component. It is **controlled** — it holds no state, it calls `onChange` with the next array. Keep `testID={`day-${day}`}`, since existing tests select on it. Preserve the existing sort (`[...cur, d].sort((a, b) => a - b)`) and the existing `chip(on)` styling.

Then replace that block in `CustomReminderSheet` with `<WeekdayPicker days={days} onChange={setDays} />`, deleting the now-unused local `DAY_CHIPS`, `ALL`, and `toggleDay`.

- [ ] **Step 4: Run tests to verify they pass**

Run from `apps/mobile/`: `npx jest src/components/reminders app/__tests__/reminders.test.tsx && npx tsc --noEmit`
Expected: PASS, including every pre-existing CustomReminderSheet test — they select on `day-N` testIDs which are preserved.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/reminders/
git commit -m "refactor(mobile): extract the weekday picker so a second reminder can reuse it"
```

---

### Task 2: Weight reminder prefs and the pure scheduler

**Files:**
- Create: `apps/mobile/src/reminders/weightPrefs.ts`
- Test: `apps/mobile/src/reminders/__tests__/weightPrefs.test.ts`

**Interfaces:**
- Consumes: `Weekday` from `@/reminders/customPrefs`
- Produces:
  - `export type WeightReminderPref = { enabled: boolean; hour: number; minute: number; days: Weekday[] }`
  - `export const DEFAULT_WEIGHT_PREF: WeightReminderPref`
  - `export async function loadWeightPref(): Promise<WeightReminderPref>`
  - `export async function saveWeightPref(p: WeightReminderPref): Promise<void>`
  - `export function nextWeightReminderAt(pref: WeightReminderPref, lastWeighedAt: Date | null, now: Date): Date | null`

- [ ] **Step 1: Write the failing test**

```typescript
import { DEFAULT_WEIGHT_PREF, nextWeightReminderAt, type WeightReminderPref } from "../weightPrefs";

// Monday 07:00, weekly. Dates below are local time, which is what the
// scheduler works in — the OS fires local triggers.
const MON_0700: WeightReminderPref = { enabled: true, hour: 7, minute: 0, days: [1] };

test("returns null when disabled", () => {
  expect(nextWeightReminderAt({ ...MON_0700, enabled: false }, null, new Date(2026, 7, 12, 9, 0))).toBeNull();
});

test("returns null when no days are selected", () => {
  expect(nextWeightReminderAt({ ...MON_0700, days: [] }, null, new Date(2026, 7, 12, 9, 0))).toBeNull();
});

test("with no weigh-in ever, returns the next Monday 07:00", () => {
  // Wed 2026-08-12 09:00 -> Mon 2026-08-17 07:00
  const got = nextWeightReminderAt(MON_0700, null, new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("weighing in earlier the same day skips that occurrence", () => {
  // Now Mon 06:45, weighed in Mon 06:40 — this Monday's 07:00 must be skipped.
  // This is the case the whole feature exists for.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 17, 6, 40), new Date(2026, 7, 17, 6, 45));
  expect(got).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});

test("weighing in the evening before still lets the reminder fire", () => {
  // Sun 20:00, next occurrence Mon 07:00 — different calendar day, so it fires.
  // The user asked to be reminded on Monday; yesterday's weigh-in is not a
  // reason to stay silent.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 16, 20, 0), new Date(2026, 7, 16, 21, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("weighing in earlier in the week still lets the reminder fire", () => {
  // Weighed in last Tuesday; the upcoming Monday must still fire.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 11, 8, 0), new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("now exactly at the scheduled minute rolls to the following week", () => {
  // Strictly after `now`, so 07:00 on the dot is already gone.
  const got = nextWeightReminderAt(MON_0700, null, new Date(2026, 7, 17, 7, 0, 0, 0));
  expect(got).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});

test("a multi-day selection picks the nearest upcoming day", () => {
  // Mon + Thu, now Tue -> Thu.
  const monThu: WeightReminderPref = { ...MON_0700, days: [1, 4] };
  const got = nextWeightReminderAt(monThu, null, new Date(2026, 7, 18, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 20, 7, 0, 0, 0));
});

test("the default pref is disabled at 07:00 on Mondays", () => {
  expect(DEFAULT_WEIGHT_PREF).toEqual({ enabled: false, hour: 7, minute: 0, days: [1] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/reminders/__tests__/weightPrefs.test.ts`
Expected: FAIL — cannot resolve `../weightPrefs`.

- [ ] **Step 3: Implement**

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Weekday } from "./customPrefs";

export type WeightReminderPref = {
  enabled: boolean;
  hour: number;
  minute: number;
  days: Weekday[];
};

// Off by default: an unsolicited new notification is worse than a missed one.
// Weekly on Monday is the honest cadence for a weigh-in — daily weighing is a
// different habit and the user can select more days if they want it.
export const DEFAULT_WEIGHT_PREF: WeightReminderPref = {
  enabled: false,
  hour: 7,
  minute: 0,
  days: [1],
};

const STORAGE_KEY = "kora.weightReminder";

// Never throws — a missing or unparseable value yields the default, matching
// loadPrefs' contract so callers always get something usable.
export async function loadWeightPref(): Promise<WeightReminderPref> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WEIGHT_PREF;
    const parsed = JSON.parse(raw) as Partial<WeightReminderPref>;
    return { ...DEFAULT_WEIGHT_PREF, ...parsed };
  } catch {
    return DEFAULT_WEIGHT_PREF;
  }
}

export async function saveWeightPref(p: WeightReminderPref): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

// occurrenceOn returns the pref's time on the given date, zeroed to the second.
function occurrenceOn(date: Date, pref: WeightReminderPref): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), pref.hour, pref.minute, 0, 0);
}

// sameCalendarDay compares local Y/M/D, not elapsed time — "did they already
// weigh in today" is a calendar question, and a UTC-based comparison would get
// it wrong for anyone not on UTC.
function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

// nextWeightReminderAt is the whole decision, kept pure and Expo-free so it is
// table-testable. It returns the next selected weekday-and-time strictly after
// `now`, skipping that occurrence when the user already weighed in ON THAT SAME
// CALENDAR DAY (or later).
//
// Same-day rather than occurrence-to-occurrence periods, deliberately. A
// period-based rule would suppress a Monday reminder because the user weighed
// in the previous Tuesday, which reads as a broken reminder — they set a Monday
// reminder because they want to be asked on Monday. The narrow case worth
// protecting is the real one: you weigh in, and the reminder fires minutes
// later nagging you about it.
export function nextWeightReminderAt(
  pref: WeightReminderPref,
  lastWeighedAt: Date | null,
  now: Date,
): Date | null {
  if (!pref.enabled || pref.days.length === 0) return null;

  const upcoming = (from: Date): Date => {
    for (let i = 0; i <= 7; i++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      if (!pref.days.includes(day.getDay() as Weekday)) continue;
      const at = occurrenceOn(day, pref);
      if (at.getTime() > from.getTime()) return at;
    }
    // Unreachable: with at least one day selected an occurrence always exists
    // within 8 days. Returning the 8-day mark keeps the function total.
    return occurrenceOn(new Date(from.getFullYear(), from.getMonth(), from.getDate() + 8), pref);
  };

  const next = upcoming(now);
  if (!lastWeighedAt) return next;
  if (sameCalendarDay(lastWeighedAt, next) || lastWeighedAt.getTime() >= next.getTime()) {
    return upcoming(next);
  }
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `apps/mobile/`: `npx jest src/reminders/__tests__/weightPrefs.test.ts && npx tsc --noEmit`
Expected: PASS, all 9.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/weightPrefs.ts apps/mobile/src/reminders/__tests__/weightPrefs.test.ts
git commit -m "feat(mobile): add weight reminder prefs and the skip-if-already-weighed scheduler"
```

---

### Task 3: `applyAllReminders` owns the weight reminder

**Files:**
- Modify: `apps/mobile/src/reminders/schedule.ts:71-110` (applyAllReminders)
- Modify: `apps/mobile/src/reminders/useReminderPrefs.ts` (its `applyAllReminders` calls)
- Modify: `apps/mobile/src/reminders/useCustomReminders.ts` (same)
- Test: `apps/mobile/src/reminders/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `nextWeightReminderAt`, `WeightReminderPref` from Task 2
- Produces: `applyAllReminders(mealPrefs, customs, weight?: { pref: WeightReminderPref; lastWeighedAt: Date | null; now: Date })` — the weight argument is optional so existing call sites keep compiling, but every call site is updated in this task

**Why this shape:** `applyAllReminders` opens with `cancelAllScheduledNotificationsAsync()`. A weight reminder scheduled anywhere else is destroyed the next time the user toggles a meal slot. One function must own the whole schedule.

- [ ] **Step 1: Write the failing test**

```typescript
test("the weight reminder is scheduled as a one-shot date trigger", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  await applyAllReminders(
    { breakfast: { enabled: false, hour: 8, minute: 0 }, lunch: { enabled: false, hour: 12, minute: 30 },
      dinner: { enabled: false, hour: 18, minute: 30 }, snack: { enabled: false, hour: 15, minute: 0 } },
    [],
    { pref: { enabled: true, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0) },
  );

  expect(scheduleSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "weight" } }),
      trigger: expect.objectContaining({ type: Notifications.SchedulableTriggerInputTypes.DATE }),
    }),
  );
});

test("a disabled weight reminder schedules nothing", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  await applyAllReminders(DEFAULT_PREFS_ALL_OFF, [], {
    pref: { enabled: false, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0),
  });

  expect(scheduleSpy).not.toHaveBeenCalled();
});

test("the weight reminder is dropped when the notification budget is exhausted", async () => {
  // 60 custom reminders on all seven days collapse to 60 daily triggers,
  // filling MAX_SCHEDULED_NOTIFICATIONS exactly. Meals-first ordering means the
  // weight reminder is the one that loses, which is the intended degradation.
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");
  const many = Array.from({ length: MAX_SCHEDULED_NOTIFICATIONS }, (_, i) => ({
    id: `c${i}`, label: `R${i}`, hour: 9, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], enabled: true,
  }));

  await applyAllReminders(DEFAULT_PREFS_ALL_OFF, many, {
    pref: { enabled: true, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0),
  });

  const weightCalls = scheduleSpy.mock.calls.filter(
    ([arg]) => (arg as { content: { data?: { kind?: string } } }).content.data?.kind === "weight",
  );
  expect(weightCalls).toHaveLength(0);
});
```

Adapt `DEFAULT_PREFS_ALL_OFF` and the Notifications mocking to whatever `schedule.test.ts` already sets up — read it first and follow it rather than introducing a second mocking style.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/reminders/__tests__/schedule.test.ts -t "weight"`
Expected: FAIL — `applyAllReminders` takes two arguments.

- [ ] **Step 3: Implement**

Add the optional third parameter and, **after** the meal and custom loops (so meals keep winning the budget), schedule the weight one-shot:

```typescript
  // Scheduled LAST and counted against the same budget: meals are the baseline
  // and must win. Unlike the others this is a one-shot DATE trigger, because a
  // repeating trigger cannot be skipped when the user has already weighed in.
  if (weight) {
    const at = nextWeightReminderAt(weight.pref, weight.lastWeighedAt, weight.now);
    if (at && scheduled < MAX_SCHEDULED_NOTIFICATIONS) {
      await Notifications.scheduleNotificationAsync({
        content: { title: "Weigh-in time", body: "Log today's weight in Kora.", data: { kind: "weight" } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
      });
      scheduled++;
    }
  }
```

Then update both call sites (`useReminderPrefs.ts` and `useCustomReminders.ts`) to load the weight pref and pass it through, so toggling a meal slot no longer wipes the weight reminder. Both already `await loadCustom()`; add `await loadWeightPref()` beside it, with `lastWeighedAt: null` and `now: new Date()` for the moment — Task 4 supplies the real last-weighed date.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest src/reminders && npx tsc --noEmit`
Expected: PASS, including pre-existing schedule tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/
git commit -m "feat(mobile): schedule the weight reminder from the single owner of the notification schedule"
```

---

### Task 4: Reconciliation on foreground and after a weight is logged

**Files:**
- Create: `apps/mobile/src/reminders/reconcileWeightReminder.ts`
- Modify: `apps/mobile/src/api/hooks.ts:587-597` (`useAddWeight`)
- Modify: `apps/mobile/app/_layout.tsx` (foreground listener)
- Test: `apps/mobile/src/reminders/__tests__/reconcileWeightReminder.test.ts`

**Interfaces:**
- Consumes: `loadWeightPref` (Task 2), `applyAllReminders` (Task 3), `loadPrefs`, `loadCustom`
- Produces: `export async function reconcileWeightReminder(lastWeighedAt: Date | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
test("reconciling re-applies the whole schedule with the supplied weigh-in date", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(new Date(2026, 7, 17, 6, 40));

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: new Date(2026, 7, 17, 6, 40) }),
  );
});

test("a null weigh-in date is passed through, so the reminder fires", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(null);

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: null }),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/reminders/__tests__/reconcileWeightReminder.test.ts`
Expected: FAIL — cannot resolve `../reconcileWeightReminder`.

- [ ] **Step 3: Implement**

```typescript
// reconcileWeightReminder recomputes the entire notification schedule with a
// fresh view of when the user last weighed in. It exists because a one-shot
// DATE trigger has to be re-armed whenever the facts change, and because
// applyAllReminders cancels everything — so the meal and custom reminders must
// be re-applied in the same breath.
export async function reconcileWeightReminder(lastWeighedAt: Date | null): Promise<void> {
  const [mealPrefs, customs, pref] = await Promise.all([loadPrefs(), loadCustom(), loadWeightPref()]);
  await applyAllReminders(mealPrefs, customs, { pref, lastWeighedAt, now: new Date() });
}
```

Wire two callers:

- **`useAddWeight`'s `onSuccess`** (`src/api/hooks.ts:587`): alongside the existing invalidation, call `void reconcileWeightReminder(new Date())` — the user just weighed in, so now is the last weigh-in.
- **App foreground** in `app/_layout.tsx`: follow the `AppState` pattern in `src/offline/drainTriggers.ts:40-42`. On `"active"`, read the most recent weight entry and reconcile. Fetch failures are caught and treated as `null` (reminder fires) per the global constraints — do not let a rejected promise escape.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS across the whole suite.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/ apps/mobile/src/api/hooks.ts apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): re-arm the weight reminder on foreground and after a weigh-in"
```

---

### Task 5: Weight section on the reminders screen

**Files:**
- Create: `apps/mobile/src/components/settings/WeightReminderSection.tsx`
- Modify: `apps/mobile/app/reminders.tsx:58` (render it below `RemindersSection`)
- Test: `apps/mobile/src/components/settings/__tests__/WeightReminderSection.test.tsx`

**Interfaces:**
- Consumes: `WeekdayPicker` (Task 1), `loadWeightPref`/`saveWeightPref`/`WeightReminderPref` (Task 2), `reconcileWeightReminder` (Task 4)
- Produces: `export function WeightReminderSection(): ReactElement`

- [ ] **Step 1: Write the failing test**

```typescript
test("the section renders disabled by default", async () => {
  const { getByLabelText } = await render(<WeightReminderSection />);
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});

test("enabling persists the pref and re-arms the schedule", async () => {
  const { getByLabelText } = await render(<WeightReminderSection />);

  await fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);

  expect(saveWeightPref).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  expect(reconcileWeightReminder).toHaveBeenCalled();
});

test("denied permission leaves the toggle off", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const { getByLabelText } = await render(<WeightReminderSection />);

  await fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);

  expect(saveWeightPref).not.toHaveBeenCalled();
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});
```

Mock `Notifications`, `weightPrefs`, and `reconcileWeightReminder` following whatever `RemindersSection.test.tsx` already does for the meal equivalent.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/settings/__tests__/WeightReminderSection.test.tsx`
Expected: FAIL — cannot resolve `../WeightReminderSection`.

- [ ] **Step 3: Implement**

Model the component on `RemindersSection.tsx`: a `GroupedSection` containing a `Switch` labelled `"Weight check-in reminder"`, a pressable time row opening the same `DateTimePicker` sheet pattern, and `<WeekdayPicker days={pref.days} onChange={…} />`. Load with `loadWeightPref()` on mount.

Permission handling must match `useReminderPrefs.setSlot`'s existing shape: when enabling, check `getPermissionsAsync`, request if not granted, and on denial force a fresh object reference into state so the controlled `Switch` reverts. Every committed change calls `saveWeightPref` and then `reconcileWeightReminder(null)` — passing `null` is correct here because the user is changing the *schedule*, not recording a weigh-in, and Task 4's foreground pass will supply the real date.

Render it in `app/reminders.tsx` immediately below `<RemindersSection />`.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/settings/ apps/mobile/app/reminders.tsx
git commit -m "feat(mobile): add a weight check-in reminder section"
```

---

### Task 6: Notifications row in Settings

**Files:**
- Modify: `apps/mobile/app/settings.tsx:30-43`
- Test: `apps/mobile/app/__tests__/settings.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```typescript
test("settings offers a route to the reminders screen", async () => {
  const { getByLabelText } = await renderSettings();

  await fireEvent.press(getByLabelText("Notifications"));

  expect(router.push).toHaveBeenCalledWith("/reminders");
});
```

If `apps/mobile/app/__tests__/settings.test.tsx` does not exist, create it, mocking `expo-router` the way the neighbouring screen tests do — check `app/__tests__/reminders.test.tsx` first.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest app/__tests__/settings.test.tsx`
Expected: FAIL — no element labelled "Notifications".

- [ ] **Step 3: Implement**

Below the existing Units `Card`, add a `GroupedSection` containing one navigable row, matching how `app/(tabs)/more.tsx` renders its rows (icon + title + chevron):

```tsx
          <GroupedSection elevated>
            <Row
              title="Notifications"
              icon={{ name: "bell", tint: colors.accent }}
              chevron
              accessibilityLabel="Notifications"
              onPress={() => router.push("/reminders" as Href)}
            />
          </GroupedSection>
```

Use whichever row component `more.tsx` uses — read it and import the same one rather than hand-rolling a pressable. The Reminders row in `more.tsx` stays exactly as it is; both paths are intended to work.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/settings.tsx apps/mobile/app/__tests__/settings.test.tsx
git commit -m "feat(mobile): add a notifications entry to settings"
```

---

## Verification

From `apps/mobile/`:

```bash
npx jest && npx tsc --noEmit
```

Then by hand on the **iPhone 17 Pro** simulator (not the Pro Max):

1. Settings → Notifications → lands on the reminders screen. The More → Reminders path still works.
2. Enable the weight reminder, set it to today a couple of minutes out, background the app, and confirm it fires.
3. Re-enable it, log a weight, and confirm the pending notification is re-armed for the following week rather than firing.
4. Toggle a meal slot and confirm the weight reminder survives — this is the `cancelAllScheduledNotificationsAsync` hazard the design is built around.
