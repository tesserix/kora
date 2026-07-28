# Custom Reminders v2 — Design Spec (Food Memory Phase 2d)

**Status:** Approved (2026-07-28)
**Builds on:** Meal Reminders v1 (PR #9, branch `reminders`). This feature extends the same on-device reminder pipeline (`prefs → buildSchedule → applyReminders → tap routing`).

## Goal

Let users create their own reminders — beyond the fixed 4 meals — as **generic nudges**: a label, a time, and which days it repeats. Tapping a custom reminder opens the app. Fully on-device (AsyncStorage + `expo-notifications`), no backend.

## Scope decisions (locked)

- **Generic nudge model.** A custom reminder is `label + time + repeat`. No per-type behavior; "weight/workout/water" are just suggested label presets that prefill the label field. Tapping the notification opens the app (no type-specific deep-link).
- **Repeat = days of week.** Every day, or a specific subset of weekdays (e.g. Mon/Wed/Fri). No intervals ("every N days").
- **Dedicated Reminders screen.** `More → Reminders` opens a full screen with a **Meals** section (the existing v1 meal rows, moved here) and a **Custom** section (list + add/edit/delete).
- **Editor = bottom sheet** (the app's shared `Sheet`, like `WeightLogSheet`).
- **Unified scheduler (Approach A).** Because `cancelAllScheduledNotificationsAsync()` wipes every scheduled notification, meals and customs are always (re)scheduled together via one `applyAllReminders`.

## Out of scope (v3+)

- Interval repeats ("every 3 days"), snooze, per-reminder sound/icon/emoji, type-specific deep-links (weight→Progress sheet, etc.), server-scheduled push, cold-start tap deep-linking (shared pre-existing push limitation).

---

## 1. Data model & storage

New AsyncStorage key `kora.customReminders` → `CustomReminder[]`.

```ts
// src/reminders/customPrefs.ts
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat (JS Date.getDay())

export type CustomReminder = {
  id: string;        // uuid (crypto/uuid available in app)
  label: string;     // trimmed, 1–40 chars, required
  hour: number;      // 0–23
  minute: number;    // 0–59
  days: Weekday[];   // non-empty; all 7 present = "every day"
  enabled: boolean;
};

export const MAX_CUSTOM_REMINDERS = 20;
export const NEW_REMINDER_DEFAULT = { hour: 9, minute: 0, days: [0,1,2,3,4,5,6] as Weekday[], enabled: true };

export async function loadCustom(): Promise<CustomReminder[]>;   // never throws → [] on missing/corrupt
export async function saveCustom(list: CustomReminder[]): Promise<void>;
```

- `loadCustom` mirrors v1 `prefs.ts`: try/catch, returns `[]` on missing or unparseable value, so callers always get a usable array. It also drops entries that fail a shape check (missing id/label, empty `days`, out-of-range hour/minute) so a corrupt entry can't reach the scheduler.
- **Cap:** `MAX_CUSTOM_REMINDERS = 20`. The "+ Add reminder" affordance is disabled with a one-line note once the cap is reached. Rationale: iOS allows 64 pending local notifications app-wide, but *notification count* isn't the same as *reminder count* — a reminder on all 7 days collapses to one daily trigger, while a weekday-subset reminder expands to one notification per selected day (up to 6). So 20 reminders can still expand to well over 64 notifications in the worst case (weekday-heavy use). `applyAllReminders` enforces a hard `MAX_SCHEDULED_NOTIFICATIONS = 60` ceiling on total scheduled requests (meals scheduled first, since they're the baseline) so scheduling degrades deterministically instead of iOS silently dropping requests past 64 — see §2. Known limitation: very heavy weekday-subset use can still hit this ceiling, and the excess customs simply won't be scheduled until others are removed or switched to all-7-days.

## 2. Unified scheduler (Approach A)

Extends `src/reminders/schedule.ts` (v1). The v1 meal-only `applyReminders` is **replaced** by `applyAllReminders`; `buildSchedule` (meals, pure) is kept and reused.

```ts
export type ScheduledNotification = {
  title: string; body: string;
  trigger:
    | { type: "daily"; hour: number; minute: number }
    | { type: "weekly"; weekday: number; hour: number; minute: number }; // expo weekday 1–7 (Sun=1)
  data: { kind: "reminder"; slot: MealSlot } | { kind: "custom"; id: string };
};

// pure — no expo, no time
export function buildCustomSchedule(reminders: CustomReminder[]): ScheduledNotification[];

// the single entry point: cancel all, then schedule meals + customs together
export async function applyAllReminders(mealPrefs: ReminderPrefs, customs: CustomReminder[]): Promise<void>;
```

- `buildCustomSchedule`: for each **enabled** reminder — if `days` contains all 7 weekdays → **one DAILY trigger** (`{type:"daily",hour,minute}`); otherwise **one WEEKLY trigger per weekday in `days`** (`{type:"weekly", weekday: jsDayToExpo(d), hour, minute}` where `jsDayToExpo(0)=1 … jsDayToExpo(6)=7`). Title = the reminder's `label`; body = a fixed nudge string (e.g. `"Reminder from Kora"`), or the label alone as title with an empty-but-present body — copy finalized in the plan. Payload `{ kind: "custom", id }`.
- `applyAllReminders`: `await cancelAllScheduledNotificationsAsync()` once, then `for` each descriptor from `buildSchedule(mealPrefs)` **and** `buildCustomSchedule(customs)` → `scheduleNotificationAsync({ content:{title,body,data}, trigger })`, mapping `{type:"daily"|"weekly"}` to `Notifications.SchedulableTriggerInputTypes.DAILY|WEEKLY`. Total scheduled requests are counted and capped at `MAX_SCHEDULED_NOTIFICATIONS = 60`, kept under iOS's 64-request app-wide limit; meals are always scheduled first (they're the baseline) and once the cap is hit the remaining descriptors — meal or custom — are simply skipped rather than sent, so scheduling degrades deterministically instead of iOS silently dropping arbitrary requests past 64.
- Everything that changes reminder state calls `applyAllReminders` with the **current** meal prefs + custom list (read from persisted/ref state, per v1's latest-value ref pattern to avoid clobbering concurrent edits).

## 3. Hook: `src/reminders/useCustomReminders.ts`

```ts
export function useCustomReminders(): {
  reminders: CustomReminder[];
  ready: boolean;
  addReminder(draft: Omit<CustomReminder, "id">): Promise<void>;   // no-op past cap
  updateReminder(r: CustomReminder): Promise<void>;
  removeReminder(id: string): Promise<void>;
  toggleReminder(id: string, enabled: boolean): Promise<void>;
};
```

- Loads on mount (`loadCustom`), keeps a `remindersRef` for latest-value reads (v1 pattern).
- Each mutation: compute next list immutably → `saveCustom(next)` → `applyAllReminders(mealPrefs, next)`. **Meal prefs** are read via `loadPrefs()` (or a shared source) so the unified apply always has both sets.
- Enabling/adding an enabled reminder ensures OS notification permission first (reuse v1's `getPermissionsAsync`/`requestPermissionsAsync` gate); on denial the change is rejected so the UI reverts.
- `addReminder` returns early (no-op) when `reminders.length >= MAX_CUSTOM_REMINDERS`.

> **Meal + custom coordination note:** meal prefs and custom reminders are two persisted sets that must be scheduled together. To avoid a stale read, `applyAllReminders` callers load the *other* set fresh (or both hooks read a shared `loadPrefs`/`loadCustom`). The plan will decide whether meals & customs share one coordinating hook or each mutation re-loads the counterpart; either satisfies "always apply both."

## 4. UI & navigation

- **`app/(tabs)/more.tsx`:** remove the inline `<RemindersSection/>`; add a `Row` **"Reminders"** (with chevron) navigating to `/reminders`.
- **`app/reminders.tsx`** (new route): `ScreenHeader` "Reminders" + `ScrollView` with:
  - **MEALS** — reuse the existing `RemindersSection` component unchanged (meal rows + v1 modal time-picker).
  - **CUSTOM** — `Overline` "Custom" + `GroupedSection`: one row per reminder (`label`, right-aligned time + weekday summary, `Switch testID="custom-switch-{id}"`), row press opens the editor pre-filled; then a **"+ Add reminder"** row (disabled + note past cap).
  - Weekday summary helper: all 7 → "Every day"; weekdays [1–5] → "Weekdays"; else short names "Mon, Wed, Fri"; single → "Mondays".
- **`src/components/reminders/CustomReminderSheet.tsx`** (new): shared `Sheet`. Fields — label `TextInput` (with preset chips: Water / Workout / Vitamins / Weigh-in that prefill the label), a time field opening the **same modal time-picker** used for meals, 7 weekday chips plus an "Every day" toggle, **Save** (`Button`), and **Delete** (only when editing; removes the reminder). Validates label non-empty (trimmed) and `days` non-empty before Save. Add mode: seeded from `NEW_REMINDER_DEFAULT`. Edit mode: seeded from the tapped reminder.
- Styling: tokens only. Weekday chips use `colors.accent` when selected, `colors.muted`/`cardSecondary` when not.

## 5. Tap routing & launch (extends v1's single listener)

- In `src/lib/push.ts`, the existing `usePushResponder` listener already branches `data.kind === "reminder" → router.push("/capture")`. Add, in the **same** callback, `data.kind === "custom" → router.push("/")` (open app to Home). No second listener/handler.
- Launch reschedule (`setupPushHandler`): replace the meal-only reschedule with
  `Promise.all([loadPrefs(), loadCustom()]).then(([m, c]) => applyAllReminders(m, c)).catch(() => {})`
  so both sets survive relaunch/reinstall.

## 6. Testing

- **Unit (pure/logic):**
  - `customPrefs`: round-trip; `[]` on missing/corrupt; drops malformed entries.
  - `buildCustomSchedule`: every-day → one DAILY; subset → one WEEKLY per day with correct expo weekday mapping; disabled excluded; empty list → `[]`; payload `{kind:"custom",id}`.
  - `applyAllReminders`: `cancelAll` called exactly once; schedules meals + customs together (counts + representative payloads for both `kind:"reminder"` and `kind:"custom"`).
  - `useCustomReminders`: add/edit/delete/toggle persist + re-sync (assert `saveCustom` + `applyAllReminders` called with the updated list); permission-deny reverts (no persist); cap enforced (add past 20 is a no-op).
- **Component:** `CustomReminderSheet` (label required/trim, preset chip prefills, weekday selection, Save→add/update, Delete→remove); `reminders.tsx` renders Meals + Custom sections; More's "Reminders" nav row navigates.
- **Full mobile suite + `tsc --noEmit` green.**
- **Device-verify:** More → Reminders; add a custom reminder (label + time + weekdays), confirm it lists and persists across reload; confirm a delivered notification shows the custom label; toggle/delete work. (On-device tap→open is subject to the same shared-`mobile`-scheme dev-client caveat as v1; routing is unit-tested.)

## 7. File summary

- New: `src/reminders/customPrefs.ts`, `src/reminders/useCustomReminders.ts`, `src/components/reminders/CustomReminderSheet.tsx`, `app/reminders.tsx` (+ tests).
- Modified: `src/reminders/schedule.ts` (add `buildCustomSchedule` + `applyAllReminders`, fold in meals), `src/lib/push.ts` (custom tap branch + launch reschedule loads both sets), `app/(tabs)/more.tsx` (inline section → nav row).
- Reused unchanged: `src/reminders/prefs.ts`, `RemindersSection.tsx`, the v1 modal time-picker sheet.

## 8. Global constraints for implementers

- On-device only; no backend, no new API. Immutable updates everywhere. Explicit types on public functions/handlers. Tokens-only styling; no hardcoded colors. No `console.log`. Reuse `MealSlot`/`@/theme`/`Sheet`/`Button`/`AppText`/`Overline`/`GroupedSection`. Single-line conventional commits, no signature; stage named files only (never `git add -A`). Branch: continue the reminders line (a new branch stacked appropriately — decided at plan time).
