import { useEffect, useRef, useState } from "react";
import type { MealSlot } from "@/lib/mealSlot";
import { useToast } from "@/components/Toast";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ReminderPref, type ReminderPrefs } from "./prefs";
import { applyAllReminders } from "./schedule";
import { loadCustom } from "./customPrefs";
import { loadWeightPref } from "./weightPrefs";
import { fetchLatestWeighInDate } from "./lastWeighIn";
import { ensureNotificationAccess, notifyNotificationAccessDenied } from "./notificationAccess";

// useReminderPrefs loads persisted reminder prefs and, on every change, persists
// them and re-syncs the OS schedule. Enabling a reminder first ensures OS
// notification permission; if the user denies it, the change is rejected so the
// UI toggle reverts.
//
// setSlot awaits an OS permission dialog before committing, so two calls for
// different slots can be in flight concurrently. `prefsRef` always holds the
// latest committed prefs (updated synchronously whenever a change commits), and
// `next` is computed from it — not from the `prefs` closed over at the time
// setSlot was created — so a slower-resolving call can never clobber a faster one.
export function useReminderPrefs() {
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const prefsRef = useRef<ReminderPrefs>(DEFAULT_PREFS);
  const toast = useToast();

  useEffect(() => {
    loadPrefs().then((p) => {
      prefsRef.current = p;
      setPrefs(p);
      setReady(true);
    });
  }, []);

  const setSlot = (slot: MealSlot, pref: ReminderPref) => {
    void (async () => {
      if (pref.enabled) {
        const access = await ensureNotificationAccess();
        if (!access.granted) {
          // denied → do not enable; force a fresh object reference so the
          // controlled Switch re-renders back to its current (unchanged) state
          setPrefs({ ...prefsRef.current });
          notifyNotificationAccessDenied(toast, access.blocked);
          return;
        }
      }
      const next = { ...prefsRef.current, [slot]: pref };
      prefsRef.current = next;
      setPrefs(next);
      await savePrefs(next);
      const customs = await loadCustom();
      const weightPref = await loadWeightPref();
      // Not `null`: the user may have already weighed in today, and passing
      // null here would forget that and re-arm the weight reminder to fire
      // anyway — the one behaviour that distinguishes it from a plain timer.
      const lastWeighedAt = await fetchLatestWeighInDate();
      await applyAllReminders(next, customs, { pref: weightPref, lastWeighedAt, now: new Date() });
    })();
  };

  return { prefs, setSlot, ready };
}
