import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import { loadPrefs } from "./prefs";
import { applyAllReminders } from "./schedule";
import { loadCustom, saveCustom, newId, MAX_CUSTOM_REMINDERS, type CustomReminder } from "./customPrefs";

// ensurePermission returns whether OS notification permission is (or becomes)
// granted, prompting once if undetermined.
async function ensurePermission(): Promise<boolean> {
  const perm = await Notifications.getPermissionsAsync();
  if (perm.granted) return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

// useCustomReminders loads persisted custom reminders and, on every mutation,
// persists them and re-syncs the whole OS schedule (meals + customs together via
// applyAllReminders). `ref` always holds the latest committed list so concurrent
// permission-gated mutations can't clobber each other (v1 pattern).
export function useCustomReminders() {
  const [reminders, setReminders] = useState<CustomReminder[]>([]);
  const [ready, setReady] = useState(false);
  const ref = useRef<CustomReminder[]>([]);

  useEffect(() => {
    loadCustom().then((list) => {
      ref.current = list;
      setReminders(list);
      setReady(true);
    });
  }, []);

  const commit = async (next: CustomReminder[]): Promise<void> => {
    ref.current = next;
    setReminders(next);
    await saveCustom(next);
    const mealPrefs = await loadPrefs();
    await applyAllReminders(mealPrefs, next);
  };

  const addReminder = async (draft: Omit<CustomReminder, "id">): Promise<void> => {
    if (ref.current.length >= MAX_CUSTOM_REMINDERS) return;
    if (draft.enabled && !(await ensurePermission())) return;
    await commit([...ref.current, { ...draft, id: newId() }]);
  };

  const updateReminder = async (r: CustomReminder): Promise<void> => {
    if (r.enabled && !(await ensurePermission())) return;
    await commit(ref.current.map((x) => (x.id === r.id ? r : x)));
  };

  const removeReminder = async (id: string): Promise<void> => {
    await commit(ref.current.filter((x) => x.id !== id));
  };

  const toggleReminder = async (id: string, enabled: boolean): Promise<void> => {
    if (enabled && !(await ensurePermission())) {
      // denied → force a fresh reference so the controlled Switch reverts
      setReminders([...ref.current]);
      return;
    }
    await commit(ref.current.map((x) => (x.id === id ? { ...x, enabled } : x)));
  };

  return { reminders, ready, addReminder, updateReminder, removeReminder, toggleReminder };
}
