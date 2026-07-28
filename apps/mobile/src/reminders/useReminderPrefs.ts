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
