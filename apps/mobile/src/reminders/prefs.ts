import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MealSlot } from "@/lib/mealSlot";

export type ReminderPref = { enabled: boolean; hour: number; minute: number };
export type ReminderPrefs = Record<MealSlot, ReminderPref>;

export const DEFAULT_PREFS: ReminderPrefs = {
  breakfast: { enabled: true, hour: 8, minute: 0 },
  lunch: { enabled: true, hour: 12, minute: 30 },
  dinner: { enabled: true, hour: 18, minute: 30 },
  snack: { enabled: false, hour: 15, minute: 0 },
};

const STORAGE_KEY = "kora.reminderPrefs";

// loadPrefs reads persisted reminder prefs, falling back to DEFAULT_PREFS on a
// missing or unparseable value — it never throws, so callers always get usable
// prefs.
export async function loadPrefs(): Promise<ReminderPrefs> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReminderPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: ReminderPrefs): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
