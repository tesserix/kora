import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import type { MealSlot } from "@/lib/mealSlot";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ReminderPref, type ReminderPrefs } from "./prefs";
import { applyAllReminders } from "./schedule";
import { loadCustom } from "./customPrefs";

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
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) {
          const req = await Notifications.requestPermissionsAsync();
          if (!req.granted) {
            // denied → do not enable; force a fresh object reference so the
            // controlled Switch re-renders back to its current (unchanged) state
            setPrefs({ ...prefsRef.current });
            return;
          }
        }
      }
      const next = { ...prefsRef.current, [slot]: pref };
      prefsRef.current = next;
      setPrefs(next);
      await savePrefs(next);
      const customs = await loadCustom();
      await applyAllReminders(next, customs);
    })();
  };

  return { prefs, setSlot, ready };
}
