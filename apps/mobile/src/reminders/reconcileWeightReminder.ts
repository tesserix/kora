import { loadPrefs } from "./prefs";
import { loadCustom } from "./customPrefs";
import { loadWeightPref } from "./weightPrefs";
import { fetchLatestWeighInDate } from "./lastWeighIn";
import { applyAllReminders, cancelAllReminders } from "./schedule";
import { resolveAuthState } from "@/lib/authState";

// run does one full reconcile pass: fresh reads of everything from storage,
// then a single applyAllReminders call.
//
// `justWeighedAt` is a weigh-in the CALLER witnessed (useAddWeight, right after
// a successful POST). Every other caller is editing the schedule, not recording
// a weigh-in, and passes nothing — meaning "I don't know", not "never weighed
// in". Those two must never be conflated: passing a placeholder `null` for
// "I don't know" re-arms the reminder for a day the user has already logged,
// which is precisely the nag this feature exists to prevent.
//
// So when the caller didn't witness one, run goes and finds out.
// fetchLatestWeighInDate never rejects and resolves to null when the fetch
// fails, so an unknown weigh-in still lets the reminder FIRE — a redundant
// reminder is a nuisance, a silently suppressed one defeats the feature.
async function run(justWeighedAt: Date | null): Promise<void> {
  // The auth gate (#171). This function is the single funnel for the launch
  // pass (setupPushHandler, module scope) and the foreground pass
  // (app/_layout.tsx), both of which used to run unconditionally. A user who
  // deleted their account and was sitting on the sign-in screen therefore
  // re-armed the deleted account's meal reminders on every relaunch — so
  // cancelling at deletion alone could never have held.
  //
  // Signed OUT is not merely "skip": it actively disarms, so reminders left
  // over from a previous session (or armed by a build from before this fix)
  // are cleaned up the next time the app opens.
  //
  // Unconfigured is neither. Destroying a working user's schedule because the
  // Firebase config went missing would be a worse bug than the one this fixes.
  const authState = await resolveAuthState();
  if (authState === "unconfigured") return;
  if (authState === "signed-out") {
    await cancelAllReminders();
    return;
  }

  const [mealPrefs, customs, pref, lastWeighedAt] = await Promise.all([
    loadPrefs(),
    loadCustom(),
    loadWeightPref(),
    justWeighedAt ? Promise.resolve(justWeighedAt) : fetchLatestWeighInDate(),
  ]);
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
//   - Coalescing is BIASED TOWARDS KNOWLEDGE, not towards recency. A witnessed
//     weigh-in is a fact; a no-argument call is an absence of information.
//     "Newest wins" would let an ignorant call queued behind a weigh-in discard
//     it, so instead the queued slot keeps any explicit date (the latest one,
//     if several arrive) and only falls back to fetching when no caller
//     witnessed anything. Nothing is lost either way: a no-argument call
//     coalesced onto a slot holding a just-logged weigh-in would have fetched
//     that very weigh-in anyway.
let tail: Promise<void> = Promise.resolve();
let queued = false;
let queuedWeighedAt: Date | null = null;

export function reconcileWeightReminder(justWeighedAt?: Date): Promise<void> {
  if (justWeighedAt && (!queuedWeighedAt || justWeighedAt.getTime() > queuedWeighedAt.getTime())) {
    queuedWeighedAt = justWeighedAt;
  }
  if (queued) return tail;
  queued = true;
  // .catch(() => {}) on the link into the chain, not on `tail` itself: a
  // prior run's rejection must not stop the NEXT run from executing, but the
  // promise returned to THIS caller (the new `tail`) still resolves/rejects
  // on this run's own outcome, so callers can still observe their own failure.
  tail = tail.catch(() => {}).then(() => {
    queued = false;
    const known = queuedWeighedAt;
    // Cleared as the slot is consumed so a later, unrelated reconcile does not
    // inherit a stale weigh-in from a run that has already happened.
    queuedWeighedAt = null;
    return run(known);
  });
  return tail;
}
