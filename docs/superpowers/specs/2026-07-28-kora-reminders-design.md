# Meal Reminders v1 — design spec (Food Memory Phase 2c)

**Goal:** Let a user set a daily reminder time per meal so Kora nudges them to log — reducing the "forgot to log" gap. Fixed times, on-device, no backend.

**Base:** stacked on `food-memory` (retarget PR to `main` after PR #7 merges).

## Behaviour

A **Reminders** section in Settings lets the user enable a per-meal reminder with a time. Kora schedules a **daily-repeating local notification** for each enabled meal via `expo-notifications`. Tapping a reminder opens the capture/log flow.

- Meals: `breakfast`, `lunch`, `dinner`, `snack` (reuses the `MealSlot` type from `@/lib/mealSlot`).
- Defaults: breakfast **08:00 on**, lunch **12:30 on**, dinner **18:30 on**, snack **15:00 off**.
- Notifications fire in the **device-local timezone** (expo daily trigger is local-time based).
- No backend, no migration — this is entirely a mobile feature.

## Data

```ts
type ReminderPref = { enabled: boolean; hour: number; minute: number };
type ReminderPrefs = Record<MealSlot, ReminderPref>;
```

Persisted in `AsyncStorage` under key `"kora.reminderPrefs"`. `DEFAULT_PREFS` provides the defaults above; a missing/corrupt stored value falls back to defaults (never throws).

## Scheduling

- **Pure `buildSchedule(prefs: ReminderPrefs): ScheduledReminder[]`** where
  `ScheduledReminder = { slot: MealSlot; hour: number; minute: number; title: string; body: string }`.
  Includes one entry per **enabled** slot only, with per-slot copy (title e.g. `"Breakfast time"`, body e.g. `"Log your breakfast in Kora."`). Fully unit-testable — no expo, no time.
- **Applier `applyReminders(prefs)`** (thin, side-effectful): `Notifications.cancelAllScheduledNotificationsAsync()` then, for each `buildSchedule(prefs)` entry, `Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: { type: SchedulableTriggerInputTypes.DAILY, hour, minute } })`. Called after any prefs change and once on app launch.
- **Permissions:** before enabling the first reminder, call `Notifications.requestPermissionsAsync()`. If denied, the toggle reverts and a muted hint ("Enable notifications in Settings to get reminders") shows. (The existing `expo-notifications` handler in `src/lib/push.ts` already sets a notification handler; reuse it — do not double-register.)

## UI

A **Reminders** section in the Settings/More screen (where "Sign out" lives). Each meal is a `Row`/list item with:
- the meal label,
- a `Switch` (enabled),
- the time (e.g. `8:00 AM`), tappable to edit.

Time editing uses a native time picker via **`@react-native-community/datetimepicker`** (Expo-supported; added with `expo install`). Toggling on with no notification permission triggers the permission request; changing a time reschedules.

A `useReminderPrefs()` hook loads prefs from AsyncStorage, exposes `prefs` + `setSlot(slot, pref)`, and on every change persists + calls `applyReminders`.

## Tap handling

Register a `Notifications.addNotificationResponseReceivedListener` (in `app/_layout.tsx`, alongside the existing push wiring) that routes a reminder tap to the capture flow: `router.push("/capture")`. Guard so it only fires for reminder notifications (tag the content with `data: { kind: "reminder", slot }`).

## Files

- Create: `src/reminders/prefs.ts` (types, `DEFAULT_PREFS`, `loadPrefs`/`savePrefs` over AsyncStorage)
- Create: `src/reminders/schedule.ts` (`buildSchedule` pure + `applyReminders` applier)
- Create: `src/reminders/useReminderPrefs.ts` (hook)
- Create: a Reminders settings section component (e.g. `src/components/settings/RemindersSection.tsx`) + wire into the More/Settings screen
- Modify: `app/_layout.tsx` (notification-response tap listener) + call `applyReminders` on launch
- Add dep: `@react-native-community/datetimepicker` via `expo install`

## Testing

- `prefs`: round-trip save/load; missing/corrupt storage → `DEFAULT_PREFS` (no throw). (Mock `@react-native-async-storage/async-storage`.)
- `buildSchedule`: only enabled slots included; correct hour/minute/title/body per slot; all-disabled → `[]`.
- `RemindersSection` (RNTL v14 `await render`): toggling a meal calls `setSlot` with `enabled` flipped; the time renders; permission-denied path reverts the toggle (mock `expo-notifications` `requestPermissionsAsync`).
- `applyReminders` is covered by mocking `expo-notifications` and asserting `cancelAll` + one `scheduleNotificationAsync` per enabled slot with the daily trigger.

## Constraints (inherited)

Tokens-only styling (`@tesserix/web`/theme primitives, `Switch` themed). RNTL v14 `await render`. Single-line conventional commits, no signature, never `git add -A`.

## Out of scope (v2, separate spec)

Smart "your usual time" reminders (server-derived typical logging time per slot); reminder snooze; streak/goal nudges; server-scheduled push (this v1 is purely on-device local notifications).
