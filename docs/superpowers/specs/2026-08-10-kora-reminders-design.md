# Kora — Reminders in Settings, and a Weight Check-In Reminder

**Date:** 2026-08-10
**Status:** Approved design, ready for planning

## Problem

Two things, one small and one real.

**1. Reminders are not where people look for them.** A 6:30pm dinner notification sent the user to
Settings to turn it off. Settings (`apps/mobile/app/settings.tsx`) contains exactly one card — the
metric/imperial toggle — and no mention of notifications. The reminder controls live at
`/reminders`, reachable only from the More tab (`apps/mobile/app/(tabs)/more.tsx:68`), where
"Reminders" sits as a *sibling* of "Settings" rather than inside it. Nothing is broken; the
information architecture just doesn't match the obvious mental model, and Settings is nearly empty
while its actual content sits next door.

**2. There is no weight check-in reminder.** Meal reminders are first-class (per-slot enable and
time, `src/reminders/prefs.ts`), and up to 20 generic custom reminders exist with label, time, and
weekdays (`src/reminders/customPrefs.ts`). A weigh-in reminder can be faked as a custom reminder,
but it has no idea whether the user has already weighed in, so it nags about something just done.

## Goals

- A notifications entry in Settings, where the user actually looked.
- A first-class weight check-in reminder that does not fire when the user has already weighed in
  for the current period.

## Non-goals

Changing meal-reminder behaviour, reworking notification copy beyond the weight reminder's own
strings, and reworking the notification-cap logic in `schedule.ts`.

## The constraint that shapes everything

Meal and custom reminders use expo's repeating `DAILY` / `WEEKLY` triggers, scheduled once by
`applyAllReminders` and then owned by the OS. **A repeating OS trigger cannot be conditionally
suppressed** — it fires whether or not the user weighed in, and it fires with the app closed.

So the weight reminder cannot reuse `buildSchedule`'s mechanism. It schedules a **one-shot `DATE`
trigger** for its next occurrence, recomputed whenever the relevant facts change. Logging a weight
simply advances the next fire past the current period.

Rejected alternatives: a repeating trigger that fires regardless (contradicts the requirement);
server-side push via the platform's `notification-service` (Kora's reminders are entirely local,
and this would make one reminder depend on push delivery and a backend job).

## Preferences

A new module beside `prefs.ts`, with its own AsyncStorage key:

```ts
export type WeightReminderPref = {
  enabled: boolean;
  hour: number;
  minute: number;
  days: Weekday[];   // reuses Weekday from customPrefs.ts (0=Sun … 6=Sat)
};
```

Default: **disabled**, 07:00, Mondays only. Weekly is the honest cadence for weigh-ins, and off by
default because an unsolicited new notification is worse than a missed one. Loading follows
`loadPrefs`'s convention exactly — never throw, fall back to the default on a missing or
unparseable value.

## Scheduling

The decision lives in one pure function, no Expo imports, fully table-testable:

```ts
nextWeightReminderAt(
  pref: WeightReminderPref,
  lastWeighedAt: Date | null,
  now: Date,
): Date | null
```

It returns the next selected weekday-and-time strictly after `now`, **skipping that occurrence
when `lastWeighedAt` falls within the current period** — where a period runs from the previous
selected occurrence up to the next one. It returns `null` when the reminder is disabled or no days
are selected.

`applyWeightReminder(pref, lastWeighedAt)` is the thin Expo wrapper: cancel the existing weight
notification by its identifier, and schedule a one-shot at the returned date (or nothing, on
`null`). It mirrors how `applyAllReminders` cancels before scheduling.

**Notification budget.** `schedule.ts` caps total pending notifications at 60, below iOS's 64,
because iOS silently drops requests past that. The weight reminder adds exactly one one-shot. The
plan must verify it is counted against that cap rather than scheduled outside it — one extra
request is harmless in isolation, but a reminder that silently never schedules because the budget
was already full is precisely the failure the cap exists to prevent.

## Reconciliation

Two triggers, both calling the same recompute:

1. **App foreground.** Follow the existing `AppState` pattern in `src/offline/drainTriggers.ts`
   rather than inventing a second one.
2. **After a weight is logged.** In the `useAddWeight` mutation's `onSuccess`
   (`src/api/hooks.ts:587`), alongside its existing `queryClient` invalidation.

One code path, two callers.

## Settings entry

A `Notifications` row on the Settings screen routing to `/reminders`, with the More row left in
place — both paths work. Settings currently renders a single bare `Card`, so the row needs a
`GroupedSection`, which is the pattern the rest of the app uses for navigable rows (see
`more.tsx`). This gives Settings a second thing and puts a signpost where the user looked.

## Weight section on `/reminders`

Its own section below the meal slots, matching `RemindersSection`'s shape: an enable switch, a
time picker, and weekday selection.

The weekday chips are **not currently a reusable control** — `CustomReminderSheet.tsx:11-16, 58`
holds them inline as a local `DAY_CHIPS` constant with a local `toggleDay`. Extract that into a
small `WeekdayPicker` component taking `{ days, onChange }`, and have both the custom-reminder
sheet and the new weight section use it. This is a targeted improvement to code the work already
touches, not speculative refactoring: the alternative is a third hand-rolled copy of the same
seven chips.

## Error handling

- **Permission denial reverts the toggle**, exactly as `useReminderPrefs.setSlot` already does.
  That logic is worth extracting and sharing rather than duplicating a third time.
- **A failed weight fetch during reconciliation is treated as "no recent weigh-in"**, so the
  reminder fires. A redundant reminder is a nuisance; a silently suppressed one defeats the
  feature.
- Scheduling failures are logged, never thrown into a render path.

## Testing

`nextWeightReminderAt` carries the bulk of it — table tests over: disabled; no days selected;
weighed in during the current period (skips); weighed in during the previous period (fires);
`lastWeighedAt` exactly at a period boundary; `now` exactly at the scheduled minute; a multi-day
selection; and a null `lastWeighedAt`.

Beyond that: logging a weight triggers a reschedule; the Settings row navigates to `/reminders`;
and the weight section's toggle reverts when permission is denied.

## Known limitation

Reconciliation happens on foreground and on weight log, not continuously. If the user weighs in on
another device, this device's reminder still fires until it next foregrounds. Kora's reminders are
local by design, so this is inherent rather than a bug to fix here.
