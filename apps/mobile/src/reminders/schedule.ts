import * as Notifications from "expo-notifications";
import type { MealSlot } from "@/lib/mealSlot";
import type { ReminderPrefs } from "./prefs";
import type { CustomReminder, Weekday } from "./customPrefs";
import { nextWeightReminderAt, type WeightReminderPref } from "./weightPrefs";

export type WeightReminderInput = { pref: WeightReminderPref; lastWeighedAt: Date | null; now: Date };

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

// iOS allows at most 64 pending local-notification requests app-wide; beyond that
// scheduleNotificationAsync silently drops requests. Cap our total below that so
// scheduling degrades deterministically (meals first) instead of iOS dropping
// arbitrary requests.
export const MAX_SCHEDULED_NOTIFICATIONS = 60;

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
//
// `weight` is REQUIRED, not optional. A call site that forgot it was already
// shipped once (and caught only in review): because this function opens by
// cancelling everything, omitting the weight reminder does not merely skip it,
// it DESTROYS the user's existing one until something else reschedules it.
// Making the parameter mandatory hands that invariant to the type checker
// instead of to reviewers.
export function applyAllReminders(
  mealPrefs: ReminderPrefs,
  customs: CustomReminder[],
  weight: WeightReminderInput,
): Promise<void> {
  // Serialised, not concurrent. Five call sites reach this function — two hooks
  // (useReminderPrefs.setSlot, useCustomReminders.commit) call it directly and
  // three go through reconcileWeightReminder's queue — and the common iOS
  // permission flow drives them into each other: the permission alert takes the
  // app active→inactive→active, so the foreground reconcile fires while the
  // hook's own permission continuation is still pending. Two interleaved
  // cancel-and-reschedules leave duplicated or missing notifications. The mutex
  // lives HERE rather than in the reconcile queue because this is the only
  // point all five share, and routing the hooks through the reconcile queue
  // would couple them to a re-read of prefs they have not finished writing.
  const run = applyTail.catch(() => {}).then(() => applyOnce(mealPrefs, customs, weight));
  applyTail = run.catch(() => {});
  return run;
}

// cancelAllReminders disarms every scheduled local notification and schedules
// nothing back. It is the exit-path counterpart to applyAllReminders: sign-out
// and account deletion previously only ever addressed REMOTE push
// (unregisterPushToken), so a deleted user's meal reminders stayed armed in the
// OS and fired for an account that no longer existed (#171).
//
// It runs on the SAME queue as applyAllReminders, and that is the whole point:
// applyAllReminders is cancel-then-reschedule, so an unserialised cancel landing
// mid-pass would be immediately undone by the rest of that pass re-arming
// reminders for the user who just left.
//
// Never rejects. Every caller is an irreversible exit path (sign-out, forced
// 401 sign-out, account deletion) where a wedged notification service must not
// block or fail the thing the user actually asked for — the same best-effort
// convention as src/lib/push.ts.
export function cancelAllReminders(): Promise<void> {
  const run = applyTail
    .catch(() => {})
    .then(() => Notifications.cancelAllScheduledNotificationsAsync())
    .catch(() => {
      // Deliberately swallowed — see above.
    });
  applyTail = run;
  return run;
}

// applyTail must never hold a rejection: one failed apply must not prevent the
// next from running.
let applyTail: Promise<void> = Promise.resolve();

async function applyOnce(
  mealPrefs: ReminderPrefs,
  customs: CustomReminder[],
  weight: WeightReminderInput,
): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  let scheduled = 0;
  // Meals first: they are the baseline and must always win when the total would
  // otherwise exceed iOS's pending-notification ceiling.
  for (const r of buildSchedule(mealPrefs)) {
    if (scheduled >= MAX_SCHEDULED_NOTIFICATIONS) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: r.title, body: r.body, data: { kind: "reminder", slot: r.slot } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: r.hour, minute: r.minute },
    });
    scheduled++;
  }
  for (const n of buildCustomSchedule(customs)) {
    if (scheduled >= MAX_SCHEDULED_NOTIFICATIONS) return;
    const content = { title: n.title, body: n.body, data: n.data };
    // Split (rather than a shared `trigger` variable) so each object literal is
    // contextually typed at its call site — TS otherwise widens
    // `SchedulableTriggerInputTypes.DAILY`/`.WEEKLY` to the base enum type when
    // they're combined via a ternary, which doesn't satisfy expo's
    // DailyTriggerInput/WeeklyTriggerInput discriminated union.
    if (n.trigger.type === "daily") {
      await Notifications.scheduleNotificationAsync({
        content,
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: n.trigger.hour, minute: n.trigger.minute },
      });
    } else {
      await Notifications.scheduleNotificationAsync({
        content,
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: n.trigger.weekday,
          hour: n.trigger.hour,
          minute: n.trigger.minute,
        },
      });
    }
    scheduled++;
  }
  // Scheduled LAST and counted against the same budget: meals are the baseline
  // and must win. Unlike the others this is a one-shot DATE trigger, because a
  // repeating trigger cannot be skipped when the user has already weighed in.
  const at = nextWeightReminderAt(weight.pref, weight.lastWeighedAt, weight.now);
  if (at && scheduled < MAX_SCHEDULED_NOTIFICATIONS) {
    await Notifications.scheduleNotificationAsync({
      content: { title: "Weigh-in time", body: "Log today's weight in Kora.", data: { kind: "weight" } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
    });
    scheduled++;
  }
}
