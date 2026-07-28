# Meal Reminders v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-meal daily reminder times that fire local notifications nudging the user to log; set in Settings, stored on-device.

**Architecture:** Mobile-only. On-device prefs (AsyncStorage) → a pure `buildSchedule` → `expo-notifications` daily local notifications. No backend.

**Tech Stack:** Expo/React Native + TypeScript + `expo-notifications` (installed) + `@react-native-community/datetimepicker` (added in Task 3). Spec: `docs/superpowers/specs/2026-07-28-kora-reminders-design.md`.

## Global Constraints

- **MealSlot** = `"breakfast" | "lunch" | "dinner" | "snack"` from `@/lib/mealSlot` — reuse it.
- **Defaults:** breakfast `{on, 8, 0}`, lunch `{on, 12, 30}`, dinner `{on, 18, 30}`, snack `{off, 15, 0}`.
- **Do NOT double-register notification infra.** `src/lib/push.ts` already calls `Notifications.setNotificationHandler(...)` and registers ONE `addNotificationResponseReceivedListener`. Reminder tap routing EXTENDS that existing listener (Task 4) — do not add a second listener or a second handler.
- **expo-notifications SDK 57 API:** daily trigger is `{ type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute }`; `scheduleNotificationAsync({ content, trigger })`; `cancelAllScheduledNotificationsAsync()`; `requestPermissionsAsync()`.
- **Testing:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` (foreground). Full suite: `npm test -- --ci`. RNTL v14 → `await render`.
- **Git:** branch `reminders`. Single-line conventional commits, no signature. Stage only named files — never `git add -A`.

---

### Task 1: Reminder prefs (types + AsyncStorage)

**Files:**
- Create: `apps/mobile/src/reminders/prefs.ts`
- Test: `apps/mobile/src/reminders/__tests__/prefs.test.ts`

**Interfaces:**
- Produces: `type ReminderPref = { enabled: boolean; hour: number; minute: number }`; `type ReminderPrefs = Record<MealSlot, ReminderPref>`; `const DEFAULT_PREFS: ReminderPrefs`; `async function loadPrefs(): Promise<ReminderPrefs>`; `async function savePrefs(p: ReminderPrefs): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/reminders/__tests__/prefs.test.ts`:

```ts
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../prefs";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockGet = AsyncStorage.getItem as jest.Mock;
const mockSet = AsyncStorage.setItem as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
});

test("loadPrefs returns defaults when nothing stored", async () => {
  mockGet.mockResolvedValueOnce(null);
  expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
});

test("loadPrefs returns defaults (no throw) when stored value is corrupt", async () => {
  mockGet.mockResolvedValueOnce("{not json");
  expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
});

test("savePrefs then loadPrefs round-trips", async () => {
  const prefs = { ...DEFAULT_PREFS, lunch: { enabled: false, hour: 13, minute: 15 } };
  await savePrefs(prefs);
  expect(mockSet).toHaveBeenCalledWith("kora.reminderPrefs", JSON.stringify(prefs));
  mockGet.mockResolvedValueOnce(JSON.stringify(prefs));
  expect(await loadPrefs()).toEqual(prefs);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/prefs.test.ts`
Expected: FAIL — cannot find module `../prefs`.

- [ ] **Step 3: Implement** — `apps/mobile/src/reminders/prefs.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MealSlot } from "@/lib/mealSlot";

export type ReminderPref = { enabled: boolean; hour: number; minute: number };
export type ReminderPrefs = Record<MealSlot, ReminderPref>;

export const DEFAULT_PREFS: ReminderPrefs = {
  breakfast: { enabled: true, hour: 8, minute: 0 },
  lunch: { enabled: true, hour: 12, minute: 30 },
  dinner: { enabled: true, hour: 18, minute: 30 },
  snack: { enabled: false, hour: 15, minute: 0 },
};

const STORAGE_KEY = "kora.reminderPrefs";

// loadPrefs reads persisted reminder prefs, falling back to DEFAULT_PREFS on a
// missing or unparseable value — it never throws, so callers always get usable
// prefs.
export async function loadPrefs(): Promise<ReminderPrefs> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReminderPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: ReminderPrefs): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/reminders/__tests__/prefs.test.ts`
Expected: PASS (3) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/prefs.ts apps/mobile/src/reminders/__tests__/prefs.test.ts
git commit -m "feat(mobile): reminder prefs storage"
```

---

### Task 2: Schedule builder + applier

**Files:**
- Create: `apps/mobile/src/reminders/schedule.ts`
- Test: `apps/mobile/src/reminders/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `ReminderPrefs` (Task 1); `MealSlot`.
- Produces: `type ScheduledReminder = { slot: MealSlot; hour: number; minute: number; title: string; body: string }`; `function buildSchedule(prefs: ReminderPrefs): ScheduledReminder[]`; `async function applyReminders(prefs: ReminderPrefs): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/reminders/__tests__/schedule.test.ts`:

```ts
import { buildSchedule, applyReminders } from "../schedule";
import { DEFAULT_PREFS } from "../prefs";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: "daily" },
}));

test("buildSchedule includes only enabled slots, with per-slot copy", () => {
  const s = buildSchedule(DEFAULT_PREFS); // breakfast/lunch/dinner on, snack off
  expect(s.map((r) => r.slot)).toEqual(["breakfast", "lunch", "dinner"]);
  const bfast = s.find((r) => r.slot === "breakfast")!;
  expect(bfast).toMatchObject({ hour: 8, minute: 0 });
  expect(bfast.title.length).toBeGreaterThan(0);
  expect(bfast.body.length).toBeGreaterThan(0);
});

test("buildSchedule returns [] when all slots disabled", () => {
  const off = {
    breakfast: { enabled: false, hour: 8, minute: 0 },
    lunch: { enabled: false, hour: 12, minute: 30 },
    dinner: { enabled: false, hour: 18, minute: 30 },
    snack: { enabled: false, hour: 15, minute: 0 },
  };
  expect(buildSchedule(off)).toEqual([]);
});

test("applyReminders cancels all then schedules one per enabled slot", async () => {
  await applyReminders(DEFAULT_PREFS);
  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "reminder", slot: "breakfast" } }),
      trigger: { type: "daily", hour: 8, minute: 0 },
    }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/reminders/__tests__/schedule.test.ts`
Expected: FAIL — cannot find module `../schedule`.

- [ ] **Step 3: Implement** — `apps/mobile/src/reminders/schedule.ts`:

```ts
import * as Notifications from "expo-notifications";
import type { MealSlot } from "@/lib/mealSlot";
import type { ReminderPrefs } from "./prefs";

export type ScheduledReminder = { slot: MealSlot; hour: number; minute: number; title: string; body: string };

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

// buildSchedule maps the enabled reminder prefs to notification descriptors —
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

// applyReminders re-syncs the OS schedule to the current prefs: clear all
// previously-scheduled reminders, then schedule a daily-repeating local
// notification for each enabled slot. Notifications carry data.kind="reminder"
// so the tap handler (src/lib/push.ts) can route them.
export async function applyReminders(prefs: ReminderPrefs): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const r of buildSchedule(prefs)) {
    await Notifications.scheduleNotificationAsync({
      content: { title: r.title, body: r.body, data: { kind: "reminder", slot: r.slot } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: r.hour, minute: r.minute },
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/reminders/__tests__/schedule.test.ts`
Expected: PASS (3) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/reminders/schedule.ts apps/mobile/src/reminders/__tests__/schedule.test.ts
git commit -m "feat(mobile): reminder schedule builder + applier"
```

---

### Task 3: Prefs hook + Reminders settings UI

**Files:**
- Add dep: `@react-native-community/datetimepicker` (`npx expo install @react-native-community/datetimepicker`)
- Create: `apps/mobile/src/reminders/useReminderPrefs.ts`
- Create: `apps/mobile/src/components/settings/RemindersSection.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx` (render `<RemindersSection />`)
- Test: `apps/mobile/src/components/settings/__tests__/RemindersSection.test.tsx`

**Interfaces:**
- Consumes: `loadPrefs`/`savePrefs`/`ReminderPrefs`/`ReminderPref` (Task 1); `applyReminders` (Task 2).
- Produces: `function useReminderPrefs(): { prefs: ReminderPrefs; setSlot: (slot: MealSlot, pref: ReminderPref) => void; ready: boolean }`; `function RemindersSection(): JSX.Element`.

- [ ] **Step 1: Add the datetimepicker dependency**

Run: `cd apps/mobile && npx expo install @react-native-community/datetimepicker`
Expected: added to `package.json` (Expo picks an SDK-57-compatible version). Stage `package.json` + `package-lock.json` with the Task-3 commit.

- [ ] **Step 2: Implement the hook** — `apps/mobile/src/reminders/useReminderPrefs.ts`:

```ts
import { useEffect, useState } from "react";
import * as Notifications from "expo-notifications";
import type { MealSlot } from "@/lib/mealSlot";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ReminderPref, type ReminderPrefs } from "./prefs";
import { applyReminders } from "./schedule";

// useReminderPrefs loads persisted reminder prefs and, on every change, persists
// them and re-syncs the OS schedule. Enabling a reminder first ensures OS
// notification permission; if the user denies it, the change is rejected so the
// UI toggle reverts.
export function useReminderPrefs() {
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadPrefs().then((p) => { setPrefs(p); setReady(true); });
  }, []);

  const setSlot = (slot: MealSlot, pref: ReminderPref) => {
    void (async () => {
      if (pref.enabled) {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) {
          const req = await Notifications.requestPermissionsAsync();
          if (!req.granted) return; // denied → do not enable; UI reverts to current state
        }
      }
      const next = { ...prefs, [slot]: pref };
      setPrefs(next);
      await savePrefs(next);
      await applyReminders(next);
    })();
  };

  return { prefs, setSlot, ready };
}
```

- [ ] **Step 3: Write the failing UI test** — `apps/mobile/src/components/settings/__tests__/RemindersSection.test.tsx`:

```tsx
import { fireEvent, render, waitFor } from "@testing-library/react-native";

const setSlot = jest.fn();
jest.mock("@/reminders/useReminderPrefs", () => ({
  useReminderPrefs: () => ({
    prefs: {
      breakfast: { enabled: true, hour: 8, minute: 0 },
      lunch: { enabled: false, hour: 12, minute: 30 },
      dinner: { enabled: true, hour: 18, minute: 30 },
      snack: { enabled: false, hour: 15, minute: 0 },
    },
    setSlot,
    ready: true,
  }),
}));

import { RemindersSection } from "../RemindersSection";

beforeEach(() => setSlot.mockReset());

test("renders a row per meal and toggling calls setSlot with the flipped enabled flag", async () => {
  const { getByText, getByTestId } = await render(<RemindersSection />);
  getByText("Breakfast");
  getByText("Lunch");
  fireEvent(getByTestId("reminder-switch-lunch"), "valueChange", true);
  expect(setSlot).toHaveBeenCalledWith("lunch", expect.objectContaining({ enabled: true, hour: 12, minute: 30 }));
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/settings/__tests__/RemindersSection.test.tsx`
Expected: FAIL — cannot find module `../RemindersSection`.

- [ ] **Step 5: Implement** — `apps/mobile/src/components/settings/RemindersSection.tsx`:

```tsx
import { useState } from "react";
import { View, Switch, Pressable } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { useReminderPrefs } from "@/reminders/useReminderPrefs";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function RemindersSection() {
  const { prefs, setSlot } = useReminderPrefs();
  const { colors, spacing } = useTheme();
  const [editing, setEditing] = useState<MealSlot | null>(null);

  return (
    <View style={{ marginTop: spacing.md }}>
      <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Reminders</Overline>
      <GroupedSection>
        {SLOTS.map((slot) => {
          const p = prefs[slot];
          return (
            <View
              key={slot}
              style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, gap: spacing.sm }}
            >
              <AppText variant="headline" style={{ flex: 1 }}>{LABEL[slot]}</AppText>
              <Pressable accessibilityLabel={`${LABEL[slot]} time`} onPress={() => setEditing(slot)} disabled={!p.enabled}>
                <AppText variant="subheadline" muted style={{ opacity: p.enabled ? 1 : 0.4 }}>{fmt(p.hour, p.minute)}</AppText>
              </Pressable>
              <Switch
                testID={`reminder-switch-${slot}`}
                value={p.enabled}
                onValueChange={(enabled) => setSlot(slot, { ...p, enabled })}
                trackColor={{ true: colors.accent, false: colors.muted }}
              />
            </View>
          );
        })}
      </GroupedSection>
      {editing ? (
        <DateTimePicker
          mode="time"
          value={new Date(2000, 0, 1, prefs[editing].hour, prefs[editing].minute)}
          onChange={(_e, date) => {
            const slot = editing;
            setEditing(null);
            if (date) setSlot(slot, { ...prefs[slot], hour: date.getHours(), minute: date.getMinutes() });
          }}
        />
      ) : null}
    </View>
  );
}
```

- [ ] **Step 6: Wire into `more.tsx`.** In `apps/mobile/app/(tabs)/more.tsx`, add `import { RemindersSection } from "@/components/settings/RemindersSection";` and render `<RemindersSection />` inside the `<ScrollView>`, after the first `<GroupedSection>` block (before the sign-out section). Keep existing rows unchanged.

- [ ] **Step 7: Run tests + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/settings/__tests__/RemindersSection.test.tsx`
Expected: PASS + tsc clean. (The test mocks `useReminderPrefs`, so no expo/AsyncStorage is exercised. If jest cannot resolve `@react-native-community/datetimepicker`, add a one-line `jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker")` at the top of the test.)

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/src/reminders/useReminderPrefs.ts apps/mobile/src/components/settings/RemindersSection.tsx "apps/mobile/app/(tabs)/more.tsx" apps/mobile/src/components/settings/__tests__/RemindersSection.test.tsx
git commit -m "feat(mobile): reminders settings section with per-meal time"
```

---

### Task 4: Tap routing + reschedule on launch

**Files:**
- Modify: `apps/mobile/src/lib/push.ts` (extend the EXISTING response listener to route reminder taps; reschedule on launch)
- Test: full mobile suite green

**Interfaces:**
- Consumes: `loadPrefs` (Task 1), `applyReminders` (Task 2).

- [ ] **Step 1: Extend the response listener + reschedule on launch.** Read `src/lib/push.ts`. It already registers ONE `Notifications.addNotificationResponseReceivedListener((response) => { ... })`. Inside that existing callback, add a branch BEFORE its current logic:

```ts
      const data = response.notification.request.content.data as { kind?: string } | undefined;
      if (data?.kind === "reminder") {
        router.push("/capture");
        return;
      }
```

(`router` is already imported in `push.ts`.) Do NOT add a second listener.

Then, where `push.ts` runs its one-time setup (the `setupPushHandler` path), add a fire-and-forget reschedule so reminders survive reinstalls/permission changes:

```ts
  import { loadPrefs } from "@/reminders/prefs";
  import { applyReminders } from "@/reminders/schedule";
  // ...inside setup, after the handler is registered:
  void loadPrefs().then(applyReminders).catch(() => {});
```

(Place the imports at the top of `push.ts` with the others; place the `void loadPrefs()...` call in the same setup function that registers the handler, guarded so it runs once.)

- [ ] **Step 2: Run the full suite + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: PASS (all) + tsc clean. If a `push.ts` test exists and breaks on the new imports, mock `@/reminders/schedule` + `@/reminders/prefs` in that test (or assert the new branch); report what you changed.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/lib/push.ts
git commit -m "feat(mobile): route reminder taps to capture + reschedule on launch"
```

---

## Device verification (controller, after all tasks)

On the sim (Metro `:8091`, demo user): open More → Reminders, toggle a meal on (grant permission), change its time via the picker. Because a daily trigger can't be waited out live, verify scheduling by setting a reminder ~1–2 min ahead and confirming the local notification fires and tapping it opens the capture screen. Confirm the section renders with 4 meals, toggles persist across an app reload, and disabled rows show a dimmed time.

## Out of scope (v2)

Smart "your usual time" reminders; snooze; server-scheduled push.
