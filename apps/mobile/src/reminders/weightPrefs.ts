import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Weekday } from "./customPrefs";

export type WeightReminderPref = {
  enabled: boolean;
  hour: number;
  minute: number;
  days: Weekday[];
};

// Off by default: an unsolicited new notification is worse than a missed one.
// Weekly on Monday is the honest cadence for a weigh-in — daily weighing is a
// different habit and the user can select more days if they want it.
export const DEFAULT_WEIGHT_PREF: WeightReminderPref = {
  enabled: false,
  hour: 7,
  minute: 0,
  days: [1],
};

const STORAGE_KEY = "kora.weightReminder";

// Never throws — a missing or unparseable value yields the default, matching
// loadPrefs' contract so callers always get something usable.
export async function loadWeightPref(): Promise<WeightReminderPref> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WEIGHT_PREF;
    const parsed = JSON.parse(raw) as Partial<WeightReminderPref>;
    return { ...DEFAULT_WEIGHT_PREF, ...parsed };
  } catch {
    return DEFAULT_WEIGHT_PREF;
  }
}

export async function saveWeightPref(p: WeightReminderPref): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

// occurrenceOn returns the pref's time on the given date, zeroed to the second.
function occurrenceOn(date: Date, pref: WeightReminderPref): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), pref.hour, pref.minute, 0, 0);
}

// sameCalendarDay compares local Y/M/D, not elapsed time — "did they already
// weigh in today" is a calendar question, and a UTC-based comparison would get
// it wrong for anyone not on UTC.
function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

// nextWeightReminderAt is the whole decision, kept pure and Expo-free so it is
// table-testable. It returns the next selected weekday-and-time strictly after
// `now`, skipping that occurrence when the user already weighed in ON THAT SAME
// CALENDAR DAY (or later).
//
// Same-day rather than occurrence-to-occurrence periods, deliberately. A
// period-based rule would suppress a Monday reminder because the user weighed
// in the previous Tuesday, which reads as a broken reminder — they set a Monday
// reminder because they want to be asked on Monday. The narrow case worth
// protecting is the real one: you weigh in, and the reminder fires minutes
// later nagging you about it.
export function nextWeightReminderAt(
  pref: WeightReminderPref,
  lastWeighedAt: Date | null,
  now: Date,
): Date | null {
  if (!pref.enabled || pref.days.length === 0) return null;

  const upcoming = (from: Date): Date => {
    for (let i = 0; i <= 7; i++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      if (!pref.days.includes(day.getDay() as Weekday)) continue;
      const at = occurrenceOn(day, pref);
      if (at.getTime() > from.getTime()) return at;
    }
    // Unreachable: with at least one day selected an occurrence always exists
    // within 8 days. Returning the 8-day mark keeps the function total.
    return occurrenceOn(new Date(from.getFullYear(), from.getMonth(), from.getDate() + 8), pref);
  };

  const next = upcoming(now);
  if (!lastWeighedAt) return next;
  if (sameCalendarDay(lastWeighedAt, next) || lastWeighedAt.getTime() >= next.getTime()) {
    return upcoming(next);
  }
  return next;
}
