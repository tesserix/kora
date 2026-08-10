import { loadPrefs } from "./prefs";
import { loadCustom } from "./customPrefs";
import { loadWeightPref } from "./weightPrefs";
import { applyAllReminders } from "./schedule";

// run does one full reconcile pass: fresh reads of everything from storage,
// then a single applyAllReminders call with the caller's lastWeighedAt.
async function run(lastWeighedAt: Date | null): Promise<void> {
  const [mealPrefs, customs, pref] = await Promise.all([loadPrefs(), loadCustom(), loadWeightPref()]);
  await applyAllReminders(mealPrefs, customs, { pref, lastWeighedAt, now: new Date() });
}

// applyAllReminders begins with cancelAllScheduledNotificationsAsync(), so two
// overlapping reconciles racing the OS scheduler can interleave: the second
// call's cancel can wipe notifications the first is still in the middle of
// (re-)scheduling, leaving the user with fewer reminders than they should
// have — or none. A rapid foreground/background/foreground cycle (swiping
// the app switcher) is enough to trigger this from app/_layout.tsx alone.
//
// This module-level chain serialises every call through a single queue:
//
//   - A call that arrives while nothing is running/queued executes next.
//   - A call that arrives while one is already running or already queued
//     behind the running one is coalesced onto that same queued slot rather
//     than starting a second one in parallel.
//   - Coalescing never drops information: `nextLastWeighedAt` is overwritten
//     by every call while queued, so the queued run always uses the NEWEST
//     lastWeighedAt at the moment it actually executes — a later call may
//     carry a just-logged weigh-in that an earlier queued call doesn't know
//     about, and silently keeping the older value would leave the schedule
//     stale.
let tail: Promise<void> = Promise.resolve();
let queued = false;
let nextLastWeighedAt: Date | null = null;

export function reconcileWeightReminder(lastWeighedAt: Date | null): Promise<void> {
  nextLastWeighedAt = lastWeighedAt;
  if (queued) return tail;
  queued = true;
  // .catch(() => {}) on the link into the chain, not on `tail` itself: a
  // prior run's rejection must not stop the NEXT run from executing, but the
  // promise returned to THIS caller (the new `tail`) still resolves/rejects
  // on this run's own outcome, so callers can still observe their own failure.
  tail = tail.catch(() => {}).then(() => {
    queued = false;
    const arg = nextLastWeighedAt;
    return run(arg);
  });
  return tail;
}
