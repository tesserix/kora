import { Platform } from "react-native";
import type { MentorHealthDayInput } from "@/api/types";

type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");

function loadHealthKit(): HealthKitModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kingstinct/react-native-healthkit") as HealthKitModule;
}

export type MentorHealthConsent = {
  steps: boolean;
  sleep: boolean;
  workouts: boolean;
  energy: boolean;
  heartRate: boolean;
};

export type MentorHealthCollection = {
  status: "disabled" | "ready" | "denied" | "unavailable";
  days: MentorHealthDayInput[];
};

const STEP_COUNT_IDENTIFIER = "HKQuantityTypeIdentifierStepCount";
const SLEEP_ANALYSIS_IDENTIFIER = "HKCategoryTypeIdentifierSleepAnalysis";
const WORKOUT_IDENTIFIER = "HKWorkoutTypeIdentifier";
const ACTIVE_ENERGY_IDENTIFIER = "HKQuantityTypeIdentifierActiveEnergyBurned";
const RESTING_HEART_RATE_IDENTIFIER = "HKQuantityTypeIdentifierRestingHeartRate";
const CUMULATIVE_SUM: readonly ["cumulativeSum"] = ["cumulativeSum"];
const DISCRETE_AVERAGE: readonly ["discreteAverage"] = ["discreteAverage"];
const ASLEEP_VALUES = new Set([1, 3, 4, 5]);
const WINDOW_DAYS = 7;
const MS_PER_MINUTE = 60_000;

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function addMetric(
  days: Map<string, MentorHealthDayInput>,
  date: string,
  observedAt: string,
  zone: string,
  metric: Partial<Pick<MentorHealthDayInput, "steps" | "sleep_minutes" | "workout_minutes" | "active_energy_kcal" | "resting_heart_rate_bpm">>,
): void {
  days.set(date, { local_date: date, timezone: zone, observed_at: observedAt, ...days.get(date), ...metric });
}

function mergedMinutes(intervals: { start: number; end: number }[]): number {
  const sorted = intervals.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return 0;
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return Math.round((total + end - start) / MS_PER_MINUTE);
}

function workoutMinutes(duration: { unit: string; quantity: number } | undefined): number | null {
  if (!duration || !Number.isFinite(duration.quantity) || duration.quantity < 0) return null;
  if (duration.unit === "min") return Math.round(duration.quantity);
  if (duration.unit === "h") return Math.round(duration.quantity * 60);
  return Math.round(duration.quantity / 60);
}

export async function collectMentorHealthDays(
  consent: MentorHealthConsent,
  now = new Date(),
): Promise<MentorHealthCollection> {
  const toRead: (
    | typeof STEP_COUNT_IDENTIFIER
    | typeof SLEEP_ANALYSIS_IDENTIFIER
    | typeof WORKOUT_IDENTIFIER
    | typeof ACTIVE_ENERGY_IDENTIFIER
    | typeof RESTING_HEART_RATE_IDENTIFIER
  )[] = [];
  if (consent.steps) toRead.push(STEP_COUNT_IDENTIFIER);
  if (consent.sleep) toRead.push(SLEEP_ANALYSIS_IDENTIFIER);
  if (consent.workouts) toRead.push(WORKOUT_IDENTIFIER);
  if (consent.energy) toRead.push(ACTIVE_ENERGY_IDENTIFIER);
  if (consent.heartRate) toRead.push(RESTING_HEART_RATE_IDENTIFIER);
  if (toRead.length === 0) return { status: "disabled", days: [] };
  if (Platform.OS !== "ios") return { status: "unavailable", days: [] };

  try {
    const healthKit = loadHealthKit();
    if (!healthKit.isHealthDataAvailable()) return { status: "unavailable", days: [] };
    if (!await healthKit.requestAuthorization({ toRead })) return { status: "denied", days: [] };

    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    windowStart.setDate(windowStart.getDate() - (WINDOW_DAYS - 1));
    const sleepWindowStart = new Date(windowStart.getTime() - 18 * 60 * MS_PER_MINUTE);

    const [stepBuckets, sleepSamples, workouts, energyBuckets, heartRateBuckets] = await Promise.all([
      consent.steps
        ? healthKit.queryStatisticsCollectionForQuantity(
          STEP_COUNT_IDENTIFIER,
          CUMULATIVE_SUM,
          windowStart,
          { day: 1 },
          { filter: { date: { startDate: windowStart, endDate: now } }, unit: "count" },
        )
        : Promise.resolve([]),
      consent.sleep
        ? healthKit.queryCategorySamples(SLEEP_ANALYSIS_IDENTIFIER, {
          filter: { date: { startDate: sleepWindowStart, endDate: now } },
          limit: 0,
        })
        : Promise.resolve([]),
      consent.workouts
        ? healthKit.queryWorkoutSamples({
          filter: { date: { startDate: windowStart, endDate: now } },
          limit: 0,
        })
        : Promise.resolve([]),
      consent.energy
        ? healthKit.queryStatisticsCollectionForQuantity(
          ACTIVE_ENERGY_IDENTIFIER,
          CUMULATIVE_SUM,
          windowStart,
          { day: 1 },
          { filter: { date: { startDate: windowStart, endDate: now } }, unit: "kcal" },
        )
        : Promise.resolve([]),
      consent.heartRate
        ? healthKit.queryStatisticsCollectionForQuantity(
          RESTING_HEART_RATE_IDENTIFIER,
          DISCRETE_AVERAGE,
          windowStart,
          { day: 1 },
          { filter: { date: { startDate: windowStart, endDate: now } }, unit: "count/min" },
        )
        : Promise.resolve([]),
    ]);

    const zone = timezone();
    const observedAt = now.toISOString();
    const firstDate = localDate(windowStart);
    const lastDate = localDate(now);
    const days = new Map<string, MentorHealthDayInput>();

    for (const bucket of stepBuckets) {
      const value = bucket.sumQuantity?.quantity;
      if (!bucket.startDate || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      const date = localDate(new Date(bucket.startDate));
      if (date >= firstDate && date <= lastDate) addMetric(days, date, observedAt, zone, { steps: Math.round(value) });
    }

    const sleepByDay = new Map<string, { start: number; end: number }[]>();
    for (const sample of sleepSamples) {
      if (!ASLEEP_VALUES.has(sample.value)) continue;
      const start = new Date(sample.startDate).getTime();
      const end = new Date(sample.endDate).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const date = localDate(new Date(end));
      if (date < firstDate || date > lastDate) continue;
      sleepByDay.set(date, [...(sleepByDay.get(date) ?? []), { start, end }]);
    }
    for (const [date, intervals] of sleepByDay) {
      addMetric(days, date, observedAt, zone, { sleep_minutes: mergedMinutes(intervals) });
    }

    const workoutByDay = new Map<string, number>();
    for (const workout of workouts) {
      const minutes = workoutMinutes(workout.duration);
      if (minutes === null) continue;
      const date = localDate(new Date(workout.startDate));
      if (date < firstDate || date > lastDate) continue;
      workoutByDay.set(date, (workoutByDay.get(date) ?? 0) + minutes);
    }
    for (const [date, minutes] of workoutByDay) {
      addMetric(days, date, observedAt, zone, { workout_minutes: minutes });
    }

    for (const bucket of energyBuckets) {
      const value = bucket.sumQuantity?.quantity;
      if (!bucket.startDate || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      const date = localDate(new Date(bucket.startDate));
      if (date >= firstDate && date <= lastDate) {
        addMetric(days, date, observedAt, zone, { active_energy_kcal: Math.round(value) });
      }
    }

    for (const bucket of heartRateBuckets) {
      const value = bucket.averageQuantity?.quantity;
      if (!bucket.startDate || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      const date = localDate(new Date(bucket.startDate));
      if (date >= firstDate && date <= lastDate) {
        addMetric(days, date, observedAt, zone, { resting_heart_rate_bpm: Math.round(value) });
      }
    }

    return { status: "ready", days: [...days.values()].sort((a, b) => a.local_date.localeCompare(b.local_date)) };
  } catch {
    return { status: "unavailable", days: [] };
  }
}
