import AsyncStorage from "@react-native-async-storage/async-storage";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat (Date.getDay())

export type CustomReminder = {
  id: string;
  label: string;
  hour: number;
  minute: number;
  days: Weekday[];
  enabled: boolean;
};

export const MAX_CUSTOM_REMINDERS = 20;

export const NEW_REMINDER_DEFAULT: { hour: number; minute: number; days: Weekday[]; enabled: boolean } = {
  hour: 9,
  minute: 0,
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
};

const STORAGE_KEY = "kora.customReminders";

// newId generates a collision-improbable local id — reminders never leave the
// device, so a uuid dependency is unnecessary.
export function newId(): string {
  return `cr_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function isValid(r: unknown): r is CustomReminder {
  const v = r as Partial<CustomReminder>;
  return (
    !!v &&
    typeof v.id === "string" && v.id.length > 0 &&
    typeof v.label === "string" && v.label.trim().length > 0 &&
    typeof v.hour === "number" && v.hour >= 0 && v.hour <= 23 &&
    typeof v.minute === "number" && v.minute >= 0 && v.minute <= 59 &&
    Array.isArray(v.days) && v.days.length > 0 &&
    typeof v.enabled === "boolean"
  );
}

// loadCustom reads persisted custom reminders, returning [] on a missing or
// unparseable value and dropping any malformed entry — it never throws, so a
// corrupt entry can never reach the scheduler.
export async function loadCustom(): Promise<CustomReminder[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

export async function saveCustom(list: CustomReminder[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
