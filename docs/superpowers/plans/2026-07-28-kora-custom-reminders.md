# Custom Reminders v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create their own generic reminders (label + time + which weekdays) alongside the fixed meal reminders, delivered as on-device local notifications.

**Architecture:** Extends the v1 on-device pipeline. New `customPrefs` storage → generalized scheduler (`buildCustomSchedule` + a unified `applyAllReminders` that schedules meals + customs together) → a `useCustomReminders` hook → a `/reminders` screen with a bottom-sheet editor → tap routing in the existing push listener. No backend.

**Tech Stack:** Expo/React Native + TypeScript + `expo-notifications` + `@react-native-community/datetimepicker` (already installed) + AsyncStorage. Spec: `docs/superpowers/specs/2026-07-28-kora-custom-reminders-design.md`.

## Global Constraints

- **On-device only.** No backend, no new API. AsyncStorage + `expo-notifications`.
- **`Weekday`** = `0|1|2|3|4|5|6` (0=Sun … 6=Sat, matches `Date.getDay()`). "Every day" = all 7 present.
- **Expo weekday mapping:** expo `WEEKLY` trigger uses weekday `1–7` with Sunday=1, so `jsDayToExpoWeekday(d) = d + 1`.
- **Storage key:** `"kora.customReminders"`. **Cap:** `MAX_CUSTOM_REMINDERS = 20`.
- **Unified scheduler (Approach A):** `applyAllReminders(mealPrefs, customs)` cancels all then schedules meals + customs together. The v1 meal-only `applyReminders` is **removed** and every caller switches to `applyAllReminders`. Each mutation re-reads the counterpart set (meals load customs; customs load meals) so both are always scheduled.
- **Notification payload:** meals carry `data:{kind:"reminder",slot}`; customs carry `data:{kind:"custom",id}`.
- **Reuse** `MealSlot`, `@/theme` tokens (`colors.accent`, `colors.accentForeground`, `colors.label`, `colors.destructive`, `colors.cardSecondary`, `colors.secondaryLabel`, `spacing`, `radius`, `fonts`), `Sheet`, `Button`, `AppText`, `Overline`, `GroupedSection`, `Row`, `ScreenHeader`. Immutable updates. Explicit types on exported functions/handlers. Tokens-only styling. No `console.log`.
- **Testing:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` (FOREGROUND — background stalls). RNTL v14 → `await render`; hooks via `renderHook`/`act` (see `src/reminders/__tests__/useReminderPrefs.test.ts`).
- **Git:** branch `custom-reminders` (off `reminders`). Single-line conventional commits, no signature. Stage only named files — never `git add -A`.

---

### Task 1: Custom reminder prefs (types + storage)

**Files:**
- Create: `apps/mobile/src/reminders/customPrefs.ts`
- Test: `apps/mobile/src/reminders/__tests__/customPrefs.test.ts`

**Interfaces:**
- Produces: `type Weekday`; `type CustomReminder = { id: string; label: string; hour: number; minute: number; days: Weekday[]; enabled: boolean }`; `const MAX_CUSTOM_REMINDERS = 20`; `const NEW_REMINDER_DEFAULT`; `function newId(): string`; `async function loadCustom(): Promise<CustomReminder[]>`; `async function saveCustom(list: CustomReminder[]): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/reminders/__tests__/customPrefs.test.ts`:

```ts
import { loadCustom, saveCustom, newId, MAX_CUSTOM_REMINDERS, type CustomReminder } from "../customPrefs";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockGet = AsyncStorage.getItem as jest.Mock;
const mockSet = AsyncStorage.setItem as jest.Mock;

const valid: CustomReminder = { id: "a", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true };

beforeEach(() => { mockGet.mockReset(); mockSet.mockReset(); });

test("loadCustom returns [] when nothing stored", async () => {
  mockGet.mockResolvedValueOnce(null);
  expect(await loadCustom()).toEqual([]);
});

test("loadCustom returns [] (no throw) when stored value is corrupt", async () => {
  mockGet.mockResolvedValueOnce("{not json");
  expect(await loadCustom()).toEqual([]);
});

test("loadCustom drops malformed entries", async () => {
  mockGet.mockResolvedValueOnce(JSON.stringify([
    valid,
    { id: "b", label: "", hour: 8, minute: 0, days: [1], enabled: true }, // empty label
    { id: "c", label: "x", hour: 8, minute: 0, days: [], enabled: true },  // empty days
    { id: "d", label: "y", hour: 99, minute: 0, days: [1], enabled: true }, // bad hour
  ]));
  expect(await loadCustom()).toEqual([valid]);
});

test("saveCustom writes JSON under the custom key", async () => {
  await saveCustom([valid]);
  expect(mockSet).toHaveBeenCalledWith("kora.customReminders", JSON.stringify([valid]));
});

test("newId returns a non-empty unique-ish string", () => {
  const a = newId();
  expect(typeof a).toBe("string");
  expect(a.length).toBeGreaterThan(0);
});

test("MAX_CUSTOM_REMINDERS is 20", () => {
  expect(MAX_CUSTOM_REMINDERS).toBe(20);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/customPrefs.test.ts`
Expected: FAIL — cannot find module `../customPrefs`.

- [ ] **Step 3: Implement** — `apps/mobile/src/reminders/customPrefs.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat (Date.getDay())

export type CustomReminder = {
  id: string;
  label: string;
  hour: number;
  minute: number;
  days: Weekday[];
  enabled: boolean;
};

export const MAX_CUSTOM_REMINDERS = 20;

export const NEW_REMINDER_DEFAULT: { hour: number; minute: number; days: Weekday[]; enabled: boolean } = {
  hour: 9,
  minute: 0,
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
};

const STORAGE_KEY = "kora.customReminders";

// newId generates a collision-improbable local id — reminders never leave the
// device, so a uuid dependency is unnecessary.
export function newId(): string {
  return `cr_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function isValid(r: unknown): r is CustomReminder {
  const v = r as Partial<CustomReminder>;
  return (
    !!v &&
    typeof v.id === "string" && v.id.length > 0 &&
    typeof v.label === "string" && v.label.trim().length > 0 &&
    typeof v.hour === "number" && v.hour >= 0 && v.hour <= 23 &&
    typeof v.minute === "number" && v.minute >= 0 && v.minute <= 59 &&
    Array.isArray(v.days) && v.days.length > 0 &&
    typeof v.enabled === "boolean"
  );
}

// loadCustom reads persisted custom reminders, returning [] on a missing or
// unparseable value and dropping any malformed entry — it never throws, so a
// corrupt entry can never reach the scheduler.
export async function loadCustom(): Promise<CustomReminder[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

export async function saveCustom(list: CustomReminder[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/reminders/__tests__/customPrefs.test.ts`
Expected: PASS (6) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/customPrefs.ts apps/mobile/src/reminders/__tests__/customPrefs.test.ts
git commit -m "feat(mobile): custom reminder prefs storage"
```

---

### Task 2: Unified scheduler + push integration

**Files:**
- Modify: `apps/mobile/src/reminders/schedule.ts` (add `buildCustomSchedule` + `applyAllReminders`; remove `applyReminders`)
- Modify: `apps/mobile/src/reminders/useReminderPrefs.ts` (call `applyAllReminders`)
- Modify: `apps/mobile/src/lib/push.ts` (custom tap branch + launch reschedule loads both sets)
- Test: `apps/mobile/src/reminders/__tests__/schedule.test.ts` (rewrite), `apps/mobile/src/reminders/__tests__/useReminderPrefs.test.ts` (update mocks), `apps/mobile/src/lib/__tests__/push.test.ts` (add custom-tap test)

**Interfaces:**
- Consumes: `CustomReminder`, `loadCustom` (Task 1); `ReminderPrefs`, `loadPrefs` (v1); `buildSchedule` (v1, kept).
- Produces: `type NotificationTrigger`; `type ScheduledNotification = { title: string; body: string; data: { kind: "custom"; id: string }; trigger: NotificationTrigger }`; `function buildCustomSchedule(reminders: CustomReminder[]): ScheduledNotification[]`; `async function applyAllReminders(mealPrefs: ReminderPrefs, customs: CustomReminder[]): Promise<void>`.

- [ ] **Step 1: Rewrite the schedule test** — replace `apps/mobile/src/reminders/__tests__/schedule.test.ts` with:

```ts
import { buildSchedule, buildCustomSchedule, applyAllReminders } from "../schedule";
import { DEFAULT_PREFS } from "../prefs";
import type { CustomReminder } from "../customPrefs";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: "daily", WEEKLY: "weekly" },
}));

const everyDay: CustomReminder = { id: "w", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true };
const mwf: CustomReminder = { id: "g", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5], enabled: true };
const off: CustomReminder = { id: "x", label: "Off one", hour: 9, minute: 0, days: [2], enabled: false };

beforeEach(() => {
  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockReset();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockReset();
});

test("buildSchedule still lists only enabled meal slots", () => {
  expect(buildSchedule(DEFAULT_PREFS).map((r) => r.slot)).toEqual(["breakfast", "lunch", "dinner"]);
});

test("buildCustomSchedule: all-7-days -> one daily trigger; label as title; custom payload", () => {
  const s = buildCustomSchedule([everyDay]);
  expect(s).toHaveLength(1);
  expect(s[0].title).toBe("Drink water");
  expect(s[0].data).toEqual({ kind: "custom", id: "w" });
  expect(s[0].trigger).toEqual({ type: "daily", hour: 15, minute: 0 });
});

test("buildCustomSchedule: weekday subset -> one weekly trigger per day (expo weekday = jsDay+1)", () => {
  const s = buildCustomSchedule([mwf]);
  expect(s).toHaveLength(3);
  expect(s.map((n) => n.trigger)).toEqual([
    { type: "weekly", weekday: 2, hour: 7, minute: 30 }, // Mon js1 -> expo2
    { type: "weekly", weekday: 4, hour: 7, minute: 30 }, // Wed js3 -> expo4
    { type: "weekly", weekday: 6, hour: 7, minute: 30 }, // Fri js5 -> expo6
  ]);
});

test("buildCustomSchedule excludes disabled reminders and returns [] for none", () => {
  expect(buildCustomSchedule([off])).toEqual([]);
  expect(buildCustomSchedule([])).toEqual([]);
});

test("applyAllReminders cancels once then schedules meals + customs together", async () => {
  await applyAllReminders(DEFAULT_PREFS, [everyDay, mwf]);
  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  // 3 meals (bfast/lunch/dinner) + 1 daily custom + 3 weekly customs = 7
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(7);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "reminder", slot: "breakfast" } }),
      trigger: { type: "daily", hour: 8, minute: 0 },
    }),
  );
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "custom", id: "g" } }),
      trigger: { type: "weekly", weekday: 2, hour: 7, minute: 30 },
    }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/schedule.test.ts`
Expected: FAIL — `buildCustomSchedule`/`applyAllReminders` not exported.

- [ ] **Step 3: Rewrite `schedule.ts`** — replace `apps/mobile/src/reminders/schedule.ts` with:

```ts
import * as Notifications from "expo-notifications";
import type { MealSlot } from "@/lib/mealSlot";
import type { ReminderPrefs } from "./prefs";
import type { CustomReminder, Weekday } from "./customPrefs";

export type ScheduledReminder = { slot: MealSlot; hour: number; minute: number; title: string; body: string };

export type NotificationTrigger =
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekly"; weekday: number; hour: number; minute: number };

export type ScheduledNotification = {
  title: string;
  body: string;
  data: { kind: "custom"; id: string };
  trigger: NotificationTrigger;
};

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };
const ALL_DAYS = 7;

// jsDayToExpoWeekday maps Date.getDay() (0=Sun) to expo's WEEKLY weekday (1=Sun).
function jsDayToExpoWeekday(d: Weekday): number {
  return d + 1;
}

// buildSchedule maps the enabled meal prefs to notification descriptors —
// pure, no expo, no time — so it is fully table-testable.
export function buildSchedule(prefs: ReminderPrefs): ScheduledReminder[] {
  return SLOTS.filter((slot) => prefs[slot].enabled).map((slot) => ({
    slot,
    hour: prefs[slot].hour,
    minute: prefs[slot].minute,
    title: `${LABEL[slot]} time`,
    body: `Log your ${slot} in Kora.`,
  }));
}

// buildCustomSchedule maps enabled custom reminders to notification descriptors —
// pure. A reminder on all 7 weekdays collapses to a single daily trigger (to
// conserve the iOS pending-notification budget); a subset produces one weekly
// trigger per selected weekday.
export function buildCustomSchedule(reminders: CustomReminder[]): ScheduledNotification[] {
  const out: ScheduledNotification[] = [];
  for (const r of reminders) {
    if (!r.enabled) continue;
    const uniqueDays = Array.from(new Set(r.days)).sort((a, b) => a - b);
    const base = { title: r.label, body: "Reminder from Kora", data: { kind: "custom" as const, id: r.id } };
    if (uniqueDays.length >= ALL_DAYS) {
      out.push({ ...base, trigger: { type: "daily", hour: r.hour, minute: r.minute } });
    } else {
      for (const d of uniqueDays) {
        out.push({ ...base, trigger: { type: "weekly", weekday: jsDayToExpoWeekday(d), hour: r.hour, minute: r.minute } });
      }
    }
  }
  return out;
}

// applyAllReminders re-syncs the OS schedule to the current meal prefs AND custom
// reminders. cancelAllScheduledNotificationsAsync clears every scheduled local
// notification, so meals and customs must be re-scheduled together in one pass —
// this is the single entry point every reminder change funnels through.
export async function applyAllReminders(mealPrefs: ReminderPrefs, customs: CustomReminder[]): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const r of buildSchedule(mealPrefs)) {
    await Notifications.scheduleNotificationAsync({
      content: { title: r.title, body: r.body, data: { kind: "reminder", slot: r.slot } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: r.hour, minute: r.minute },
    });
  }
  for (const n of buildCustomSchedule(customs)) {
    const trigger =
      n.trigger.type === "daily"
        ? { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: n.trigger.hour, minute: n.trigger.minute }
        : { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: n.trigger.weekday, hour: n.trigger.hour, minute: n.trigger.minute };
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, data: n.data },
      trigger,
    });
  }
}
```

- [ ] **Step 4: Update `useReminderPrefs.ts`** — change the schedule import and the apply call. Replace line 5 import and the `applyReminders(next)` call:

Change:
```ts
import { applyReminders } from "./schedule";
```
to:
```ts
import { applyAllReminders } from "./schedule";
import { loadCustom } from "./customPrefs";
```

Change (inside `setSlot`, the two lines after `await savePrefs(next);`):
```ts
      await savePrefs(next);
      await applyReminders(next);
```
to:
```ts
      await savePrefs(next);
      const customs = await loadCustom();
      await applyAllReminders(next, customs);
```

- [ ] **Step 5: Update `useReminderPrefs.test.ts`** — it currently mocks `../schedule` with `applyReminders`. Update the mock and assertions: mock `applyAllReminders` instead of `applyReminders`, and add a mock for `../customPrefs` so `loadCustom` resolves to `[]`. At the top of the file, change the schedule mock to:

```ts
jest.mock("../schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));
jest.mock("../customPrefs", () => ({ loadCustom: jest.fn(async () => []) }));
```

Then update every reference from `applyReminders` to `applyAllReminders` in imports/assertions, and where a test asserted `applyReminders` was called with `next`, assert `applyAllReminders` was called with `(next, [])`. Import them as:

```ts
import { applyAllReminders } from "../schedule";
```

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/useReminderPrefs.test.ts` and fix any remaining `applyReminders` references until green.

- [ ] **Step 6: Update `push.ts`** — the custom tap branch + launch reschedule.

Change the import line `import { applyReminders } from "@/reminders/schedule";` to:
```ts
import { applyAllReminders } from "@/reminders/schedule";
```
Add, next to the existing `import { loadPrefs } from "@/reminders/prefs";`:
```ts
import { loadCustom } from "@/reminders/customPrefs";
```

In `setupPushHandler`, replace:
```ts
  void loadPrefs().then(applyReminders).catch(() => {});
```
with:
```ts
  void Promise.all([loadPrefs(), loadCustom()])
    .then(([mealPrefs, customs]) => applyAllReminders(mealPrefs, customs))
    .catch(() => {});
```

In `usePushResponder`, after the existing `if (data?.kind === "reminder") { … }` block, add:
```ts
      if (data?.kind === "custom") {
        router.push("/");
        return;
      }
```

- [ ] **Step 7: Update `push.test.ts`** — add a custom-tap test and keep the file hermetic. Add these mocks near the other `jest.mock` calls (so importing `push.ts` doesn't hit real schedule/prefs):

```ts
jest.mock("@/reminders/schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));
jest.mock("@/reminders/prefs", () => ({ loadPrefs: jest.fn(async () => ({})) }));
jest.mock("@/reminders/customPrefs", () => ({ loadCustom: jest.fn(async () => []) }));
```

Add a test alongside the existing reminder-tap test (reuse the pattern that captures the listener callback via `(Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0]`):

```ts
test("tapping a custom reminder routes to Home", () => {
  renderHook(() => usePushResponder());
  const cb = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
  cb({ notification: { request: { content: { data: { kind: "custom", id: "cr_1" } } } } });
  expect(router.push).toHaveBeenCalledWith("/");
});
```

(If the existing reminder-tap tests already import `renderHook`, `usePushResponder`, `Notifications`, and `router` mocks, reuse them; otherwise mirror their setup.)

- [ ] **Step 8: Run everything for this task**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/reminders/__tests__/schedule.test.ts src/reminders/__tests__/useReminderPrefs.test.ts src/lib/__tests__/push.test.ts`
Expected: all PASS + tsc clean.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/reminders/schedule.ts apps/mobile/src/reminders/useReminderPrefs.ts apps/mobile/src/lib/push.ts apps/mobile/src/reminders/__tests__/schedule.test.ts apps/mobile/src/reminders/__tests__/useReminderPrefs.test.ts apps/mobile/src/lib/__tests__/push.test.ts
git commit -m "feat(mobile): unified reminder scheduler + custom tap routing"
```

---

### Task 3: useCustomReminders hook

**Files:**
- Create: `apps/mobile/src/reminders/useCustomReminders.ts`
- Test: `apps/mobile/src/reminders/__tests__/useCustomReminders.test.ts`

**Interfaces:**
- Consumes: `loadCustom`/`saveCustom`/`newId`/`MAX_CUSTOM_REMINDERS`/`CustomReminder` (Task 1); `loadPrefs` (v1); `applyAllReminders` (Task 2).
- Produces: `function useCustomReminders(): { reminders: CustomReminder[]; ready: boolean; addReminder(draft: Omit<CustomReminder, "id">): Promise<void>; updateReminder(r: CustomReminder): Promise<void>; removeReminder(id: string): Promise<void>; toggleReminder(id: string, enabled: boolean): Promise<void> }`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/reminders/__tests__/useCustomReminders.test.ts`:

```ts
import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useCustomReminders } from "../useCustomReminders";
import { loadCustom, saveCustom, MAX_CUSTOM_REMINDERS, type CustomReminder } from "../customPrefs";
import { applyAllReminders } from "../schedule";

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));
jest.mock("../customPrefs", () => {
  const actual = jest.requireActual("../customPrefs");
  return { ...actual, loadCustom: jest.fn(async () => []), saveCustom: jest.fn(async () => {}) };
});
jest.mock("../prefs", () => ({ loadPrefs: jest.fn(async () => ({})) }));
jest.mock("../schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));

const mockLoad = loadCustom as jest.Mock;
const mockSave = saveCustom as jest.Mock;
const mockApply = applyAllReminders as jest.Mock;
const draft = { label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] as CustomReminder["days"], enabled: true };

beforeEach(() => {
  jest.clearAllMocks();
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  mockLoad.mockResolvedValue([]);
});

test("addReminder persists + re-syncs, assigning an id", async () => {
  const { result } = renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.addReminder(draft); });
  expect(mockSave).toHaveBeenCalledTimes(1);
  const saved = mockSave.mock.calls[0][0] as CustomReminder[];
  expect(saved).toHaveLength(1);
  expect(saved[0].id.length).toBeGreaterThan(0);
  expect(saved[0].label).toBe("Drink water");
  expect(mockApply).toHaveBeenCalledWith({}, saved);
});

test("addReminder is a no-op at the cap", async () => {
  mockLoad.mockResolvedValue(
    Array.from({ length: MAX_CUSTOM_REMINDERS }, (_, i) => ({ id: `id${i}`, label: `r${i}`, hour: 9, minute: 0, days: [1], enabled: true })),
  );
  const { result } = renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(MAX_CUSTOM_REMINDERS));
  await act(async () => { await result.current.addReminder(draft); });
  expect(mockSave).not.toHaveBeenCalled();
});

test("toggleReminder off does not require permission and persists", async () => {
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: true }]);
  const { result } = renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.toggleReminder("a", false); });
  expect((mockSave.mock.calls[0][0] as CustomReminder[])[0].enabled).toBe(false);
});

test("enabling with permission denied does not persist", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: false }]);
  const { result } = renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.toggleReminder("a", true); });
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

test("removeReminder drops it and re-syncs", async () => {
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: true }]);
  const { result } = renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.removeReminder("a"); });
  expect(mockSave).toHaveBeenCalledWith([]);
  expect(mockApply).toHaveBeenCalledWith({}, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/useCustomReminders.test.ts`
Expected: FAIL — cannot find module `../useCustomReminders`.

- [ ] **Step 3: Implement** — `apps/mobile/src/reminders/useCustomReminders.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import { loadPrefs } from "./prefs";
import { applyAllReminders } from "./schedule";
import { loadCustom, saveCustom, newId, MAX_CUSTOM_REMINDERS, type CustomReminder } from "./customPrefs";

// ensurePermission returns whether OS notification permission is (or becomes)
// granted, prompting once if undetermined.
async function ensurePermission(): Promise<boolean> {
  const perm = await Notifications.getPermissionsAsync();
  if (perm.granted) return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

// useCustomReminders loads persisted custom reminders and, on every mutation,
// persists them and re-syncs the whole OS schedule (meals + customs together via
// applyAllReminders). `ref` always holds the latest committed list so concurrent
// permission-gated mutations can't clobber each other (v1 pattern).
export function useCustomReminders() {
  const [reminders, setReminders] = useState<CustomReminder[]>([]);
  const [ready, setReady] = useState(false);
  const ref = useRef<CustomReminder[]>([]);

  useEffect(() => {
    loadCustom().then((list) => {
      ref.current = list;
      setReminders(list);
      setReady(true);
    });
  }, []);

  const commit = async (next: CustomReminder[]): Promise<void> => {
    ref.current = next;
    setReminders(next);
    await saveCustom(next);
    const mealPrefs = await loadPrefs();
    await applyAllReminders(mealPrefs, next);
  };

  const addReminder = async (draft: Omit<CustomReminder, "id">): Promise<void> => {
    if (ref.current.length >= MAX_CUSTOM_REMINDERS) return;
    if (draft.enabled && !(await ensurePermission())) return;
    await commit([...ref.current, { ...draft, id: newId() }]);
  };

  const updateReminder = async (r: CustomReminder): Promise<void> => {
    if (r.enabled && !(await ensurePermission())) return;
    await commit(ref.current.map((x) => (x.id === r.id ? r : x)));
  };

  const removeReminder = async (id: string): Promise<void> => {
    await commit(ref.current.filter((x) => x.id !== id));
  };

  const toggleReminder = async (id: string, enabled: boolean): Promise<void> => {
    if (enabled && !(await ensurePermission())) {
      // denied → force a fresh reference so the controlled Switch reverts
      setReminders([...ref.current]);
      return;
    }
    await commit(ref.current.map((x) => (x.id === id ? { ...x, enabled } : x)));
  };

  return { reminders, ready, addReminder, updateReminder, removeReminder, toggleReminder };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/reminders/__tests__/useCustomReminders.test.ts`
Expected: PASS (5) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/useCustomReminders.ts apps/mobile/src/reminders/__tests__/useCustomReminders.test.ts
git commit -m "feat(mobile): useCustomReminders hook"
```

---

### Task 4: CustomReminderSheet editor

**Files:**
- Create: `apps/mobile/src/components/reminders/CustomReminderSheet.tsx`
- Test: `apps/mobile/src/components/reminders/__tests__/CustomReminderSheet.test.tsx`

**Interfaces:**
- Consumes: `Sheet`, `Button`, `AppText`, `Overline`, `useTheme`; `NEW_REMINDER_DEFAULT`, `CustomReminder`, `Weekday` (Task 1).
- Produces: `function CustomReminderSheet(props: { visible: boolean; editing: CustomReminder | null; onClose: () => void; onSave: (draft: Omit<CustomReminder, "id">, id: string | null) => void; onDelete: (id: string) => void }): JSX.Element`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/components/reminders/__tests__/CustomReminderSheet.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("@/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? children : null) }));

import { CustomReminderSheet } from "../CustomReminderSheet";

const noop = () => {};

test("add mode: entering a label and saving calls onSave with a null id and trimmed label", () => {
  const onSave = jest.fn();
  const { getByPlaceholderText, getByText } = render(
    <CustomReminderSheet visible editing={null} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  fireEvent.changeText(getByPlaceholderText("Reminder label"), "  Drink water  ");
  fireEvent.press(getByText("Save"));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ label: "Drink water", days: [0, 1, 2, 3, 4, 5, 6], enabled: true }),
    null,
  );
});

test("saving with an empty label shows an error and does not call onSave", () => {
  const onSave = jest.fn();
  const { getByText } = render(
    <CustomReminderSheet visible editing={null} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  fireEvent.press(getByText("Save"));
  expect(onSave).not.toHaveBeenCalled();
  getByText("Enter a label.");
});

test("edit mode: tapping Delete calls onDelete with the id", () => {
  const onDelete = jest.fn();
  const editing = { id: "a", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5] as any, enabled: true };
  const { getByText } = render(
    <CustomReminderSheet visible editing={editing} onClose={noop} onSave={noop} onDelete={onDelete} />,
  );
  fireEvent.press(getByText("Delete reminder"));
  expect(onDelete).toHaveBeenCalledWith("a");
});

test("deselecting all days then saving shows the days error", () => {
  const onSave = jest.fn();
  const editing = { id: "a", label: "Workout", hour: 7, minute: 30, days: [1] as any, enabled: true };
  const { getByText, getByTestId } = render(
    <CustomReminderSheet visible editing={editing} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  fireEvent.press(getByTestId("day-1")); // toggle Monday off -> no days selected
  fireEvent.press(getByText("Save"));
  expect(onSave).not.toHaveBeenCalled();
  getByText("Pick at least one day.");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/reminders/__tests__/CustomReminderSheet.test.tsx`
Expected: FAIL — cannot find module `../CustomReminderSheet`.

- [ ] **Step 3: Implement** — `apps/mobile/src/components/reminders/CustomReminderSheet.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useTheme } from "@/theme";
import { NEW_REMINDER_DEFAULT, type CustomReminder, type Weekday } from "@/reminders/customPrefs";

const DAY_CHIPS: { day: Weekday; label: string }[] = [
  { day: 0, label: "S" }, { day: 1, label: "M" }, { day: 2, label: "T" },
  { day: 3, label: "W" }, { day: 4, label: "T" }, { day: 5, label: "F" }, { day: 6, label: "S" },
];
const PRESETS = ["Drink water", "Workout", "Vitamins", "Weigh-in"];
const ALL: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

interface Props {
  visible: boolean;
  editing: CustomReminder | null;
  onClose: () => void;
  onSave: (draft: Omit<CustomReminder, "id">, id: string | null) => void;
  onDelete: (id: string) => void;
}

export function CustomReminderSheet({ visible, editing, onClose, onSave, onDelete }: Props) {
  const { colors, spacing, radius, fonts } = useTheme();
  const [label, setLabel] = useState("");
  const [hour, setHour] = useState(NEW_REMINDER_DEFAULT.hour);
  const [minute, setMinute] = useState(NEW_REMINDER_DEFAULT.minute);
  const [days, setDays] = useState<Weekday[]>(NEW_REMINDER_DEFAULT.days);
  const [showPicker, setShowPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (editing) {
      setLabel(editing.label);
      setHour(editing.hour);
      setMinute(editing.minute);
      setDays(editing.days);
    } else {
      setLabel("");
      setHour(NEW_REMINDER_DEFAULT.hour);
      setMinute(NEW_REMINDER_DEFAULT.minute);
      setDays(NEW_REMINDER_DEFAULT.days);
    }
    setErr(null);
    setShowPicker(false);
  }, [visible, editing]);

  const toggleDay = (d: Weekday) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));

  const save = () => {
    const trimmed = label.trim();
    if (!trimmed) { setErr("Enter a label."); return; }
    if (days.length === 0) { setErr("Pick at least one day."); return; }
    onSave({ label: trimmed, hour, minute, days, enabled: editing ? editing.enabled : true }, editing ? editing.id : null);
  };

  const chip = (selected: boolean) => ({
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: selected ? colors.accent : colors.cardSecondary,
  });

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{editing ? "Edit reminder" : "New reminder"}</Overline>

        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Reminder label"
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel="Reminder label"
          style={{ fontSize: 20, fontFamily: fonts.body, color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, marginTop: spacing.md }}
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm }}>
          {PRESETS.map((p) => (
            <Pressable key={p} onPress={() => setLabel(p)} style={chip(false)}>
              <AppText variant="footnote" muted>{p}</AppText>
            </Pressable>
          ))}
        </View>

        <Pressable accessibilityLabel="Reminder time" onPress={() => setShowPicker((s) => !s)} style={{ marginTop: spacing.md, flexDirection: "row", justifyContent: "space-between" }}>
          <AppText variant="headline">Time</AppText>
          <AppText variant="headline" style={{ color: colors.accent }}>{fmt(hour, minute)}</AppText>
        </Pressable>
        {showPicker ? (
          <DateTimePicker
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            value={new Date(2000, 0, 1, hour, minute)}
            textColor={colors.label}
            onChange={(_e, date) => {
              if (Platform.OS !== "ios") setShowPicker(false);
              if (date) { setHour(date.getHours()); setMinute(date.getMinutes()); }
            }}
          />
        ) : null}

        <View style={{ flexDirection: "row", gap: spacing.xs, marginTop: spacing.md }}>
          {DAY_CHIPS.map(({ day, label: l }) => {
            const on = days.includes(day);
            return (
              <Pressable key={day} testID={`day-${day}`} onPress={() => toggleDay(day)} style={[chip(on), { minWidth: 40, alignItems: "center" }]}>
                <AppText variant="subheadline" style={{ color: on ? colors.accentForeground : colors.label }}>{l}</AppText>
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={() => setDays(ALL)} style={{ marginTop: spacing.sm }}>
          <AppText variant="footnote" muted>Every day</AppText>
        </Pressable>

        {err ? <AppText style={{ color: colors.destructive, marginTop: spacing.sm }}>{err}</AppText> : null}

        <View style={{ marginTop: spacing.lg }}>
          <Button title="Save" onPress={save} />
        </View>
        {editing ? (
          <Pressable onPress={() => onDelete(editing.id)} style={{ marginTop: spacing.md, alignItems: "center" }}>
            <AppText style={{ color: colors.destructive }}>Delete reminder</AppText>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/reminders/__tests__/CustomReminderSheet.test.tsx`
Expected: PASS (4) + tsc clean. (If `useTheme()` does not expose `fonts`, use the same font access pattern as `WeightLogSheet.tsx` — check its `useTheme()` destructure and match it.)

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/reminders/CustomReminderSheet.tsx apps/mobile/src/components/reminders/__tests__/CustomReminderSheet.test.tsx
git commit -m "feat(mobile): custom reminder editor sheet"
```

---

### Task 5: Reminders screen + More nav row

**Files:**
- Create: `apps/mobile/app/reminders.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx` (remove inline `<RemindersSection/>`; add a "Reminders" nav `Row`)
- Test: `apps/mobile/app/__tests__/reminders.test.tsx`

**Interfaces:**
- Consumes: `RemindersSection` (v1); `useCustomReminders` (Task 3); `CustomReminderSheet` (Task 4); `CustomReminder`, `MAX_CUSTOM_REMINDERS` (Task 1); `Overline`, `GroupedSection`, `Row`, `AppText`, `ScreenHeader`, `useTheme`.
- Produces: default-exported `Reminders` screen component; a `daysSummary(days)` helper (module-local).

- [ ] **Step 1: Write the failing test** — `apps/mobile/app/__tests__/reminders.test.tsx`:

```tsx
import { render, waitFor } from "@testing-library/react-native";

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("@/components/settings/RemindersSection", () => ({ RemindersSection: () => null }));

const reminders = [
  { id: "a", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true },
  { id: "b", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5], enabled: false },
];
jest.mock("@/reminders/useCustomReminders", () => ({
  useCustomReminders: () => ({
    reminders,
    ready: true,
    addReminder: jest.fn(),
    updateReminder: jest.fn(),
    removeReminder: jest.fn(),
    toggleReminder: jest.fn(),
  }),
}));

import RemindersScreen from "../reminders";

test("lists custom reminders with label + day summary and an Add row", async () => {
  const { getByText } = await render(<RemindersScreen />);
  getByText("Custom");
  getByText("Drink water");
  getByText("Every day");
  getByText("Workout");
  getByText("Mon, Wed, Fri");
  getByText("Add reminder");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci "app/__tests__/reminders.test.tsx"`
Expected: FAIL — cannot find module `../reminders`.

- [ ] **Step 3: Implement** — `apps/mobile/app/reminders.tsx`:

```tsx
import { useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Overline } from "@/components/Overline";
import { GroupedSection, Row } from "@/components/GroupedList";
import { AppText } from "@/components/Text";
import { RemindersSection } from "@/components/settings/RemindersSection";
import { CustomReminderSheet } from "@/components/reminders/CustomReminderSheet";
import { useCustomReminders } from "@/reminders/useCustomReminders";
import { MAX_CUSTOM_REMINDERS, type CustomReminder, type Weekday } from "@/reminders/customPrefs";
import { useTheme } from "@/theme";

const SHORT: Record<Weekday, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

// daysSummary renders a compact human label for a reminder's weekdays.
function daysSummary(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size >= 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d as Weekday))) return "Weekdays";
  return [...days].sort((a, b) => a - b).map((d) => SHORT[d]).join(", ");
}

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export default function Reminders() {
  const insets = useSafeAreaInsets();
  const { colors, spacing } = useTheme();
  const { reminders, addReminder, updateReminder, removeReminder, toggleReminder } = useCustomReminders();
  const [editing, setEditing] = useState<CustomReminder | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const openAdd = () => { setEditing(null); setSheetOpen(true); };
  const openEdit = (r: CustomReminder) => { setEditing(r); setSheetOpen(true); };
  const atCap = reminders.length >= MAX_CUSTOM_REMINDERS;

  return (
    <AppBackground>
      <ScreenHeader title="Reminders" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <RemindersSection />

        <View style={{ marginTop: spacing.lg }}>
          <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Custom</Overline>
          <GroupedSection>
            {reminders.map((r) => (
              <Row
                key={r.id}
                title={r.label}
                detail={`${fmt(r.hour, r.minute)} · ${daysSummary(r.days)}`}
                onPress={() => openEdit(r)}
                right={
                  <Switch
                    testID={`custom-switch-${r.id}`}
                    value={r.enabled}
                    onValueChange={(enabled) => toggleReminder(r.id, enabled)}
                    trackColor={{ true: colors.accent, false: colors.muted }}
                  />
                }
              />
            ))}
            <Row
              title="Add reminder"
              icon={{ name: "bell", tint: colors.accent }}
              onPress={atCap ? undefined : openAdd}
            />
          </GroupedSection>
          {atCap ? (
            <AppText variant="footnote" muted style={{ marginLeft: spacing.md, marginTop: spacing.xs }}>
              You’ve reached the {MAX_CUSTOM_REMINDERS}-reminder limit.
            </AppText>
          ) : null}
        </View>
      </ScrollView>

      <CustomReminderSheet
        visible={sheetOpen}
        editing={editing}
        onClose={() => setSheetOpen(false)}
        onSave={(draft, id) => {
          setSheetOpen(false);
          if (id) updateReminder({ ...draft, id });
          else addReminder(draft);
        }}
        onDelete={(id) => { setSheetOpen(false); removeReminder(id); }}
      />
    </AppBackground>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci "app/__tests__/reminders.test.tsx"`
Expected: PASS + tsc clean. (If `ScreenHeader`/`AppBackground` require props, match how `app/(tabs)/more.tsx` uses them — check that file's imports/usage.)

- [ ] **Step 5: Wire the More nav row** — in `apps/mobile/app/(tabs)/more.tsx`:
  1. Remove the `import { RemindersSection } from "@/components/settings/RemindersSection";` line and the `<RemindersSection />` render (it now lives on the `/reminders` screen).
  2. In the `GroupedSection` that contains the `Settings` row, add a `Reminders` row after `Settings`:

```tsx
          <Row
            title="Reminders"
            icon={{ name: "bell", tint: colors.accent }}
            chevron
            onPress={() => router.push("/reminders" as Href)}
          />
```

  (`router`, `Href`, `Row`, `colors` are already imported in `more.tsx`.)

- [ ] **Step 6: Run the More test + full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: all PASS + tsc clean. If `more.test.tsx` asserted on the inline meal rows, update it to expect the new "Reminders" row instead (the meal rows moved to `/reminders`); report what you changed.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/reminders.tsx "apps/mobile/app/(tabs)/more.tsx" apps/mobile/app/__tests__/reminders.test.tsx
git commit -m "feat(mobile): reminders screen with custom reminders + More nav row"
```

If `more.test.tsx` needed changes, stage it in this commit too.

---

## Device verification (controller, after all tasks)

On the sim (demo user): More → **Reminders**. Confirm the **Meals** section still renders + toggles (v1 unchanged) and a **Custom** section appears. Tap **Add reminder** → the editor sheet opens; enter a label (or tap a preset), set a time, pick weekdays (or "Every day"), Save → it appears in the list with the right time + day summary and persists across an app reload. Toggle it off/on; open it to Edit; Delete removes it. Confirm a delivered custom notification shows the label as its title. (On-device notification-tap routing is subject to the same shared-`mobile`-scheme dev-client caveat as v1; the routing branch is unit-tested.)

## Out of scope (v3)

Interval repeats ("every N days"), snooze, per-reminder icon/sound, type-specific deep-links (weight→Progress sheet), server-scheduled push, cold-start tap deep-linking.
