import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { inferActivityLevel, type ActivityInference } from "./inferActivity";

// Same lazy-require reasoning as useHealth: `@kingstinct/react-native-healthkit`
// is a Nitro native module that throws at IMPORT time on any build where the
// native side isn't linked. Requiring it inside the guarded call defers that to
// call time, where the try/catch turns a missing module into an honest
// "unavailable" instead of a redbox.
type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");
function loadHealthKit(): HealthKitModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kingstinct/react-native-healthkit") as HealthKitModule;
}

const STEP_COUNT_IDENTIFIER = "HKQuantityTypeIdentifierStepCount";
const WORKOUT_IDENTIFIER = "HKWorkoutTypeIdentifier";

const WINDOW_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Multi-day step totals are read through a cumulative-sum STATISTICS COLLECTION
// query, never by summing raw samples. queryQuantitySamples returns every source's
// samples — iPhone, Apple Watch, and any third-party app — with no dedup, so a
// Watch user's daily totals came out inflated, which in turn pushed
// inferActivityLevel (and therefore the calorie target) into a higher band than
// their real activity supports. Only a statistics query applies HealthKit's
// source-priority dedup. useHealth.ts already does exactly this for today's total
// (HKStatisticsQuery/.cumulativeSum); this mirrors it across the whole window via
// HKStatisticsCollectionQuery.
const CUMULATIVE_SUM: readonly ["cumulativeSum"] = ["cumulativeSum"];

export type ActivityHistoryStatus =
  | "idle" // not asked yet — the manual card list is showing
  | "loading"
  | "unavailable" // non-iOS, or HealthKit absent
  | "denied"
  | "insufficient" // authorized, but not enough data to infer honestly
  | "ready";

export type ActivityHistory = {
  status: ActivityHistoryStatus;
  inference: ActivityInference | null;
  request: () => void;
};

function startOfLocalDay(d: Date): number {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** The shape this hook needs from a HealthKit statistics-collection bucket. */
export type StepStatisticsBucket = {
  readonly startDate?: Date;
  readonly sumQuantity?: { readonly unit: string; readonly quantity: number };
};

/**
 * Extracts one total per day from HealthKit's per-day statistics buckets
 * (queryStatisticsCollectionForQuantity, anchored to local midnight with a
 * `{ day: 1 }` interval). A bucket's `sumQuantity` is deliberately treated as
 * two distinct facts, not one:
 *
 * - ABSENT (no `sumQuantity` at all) means HealthKit has no data for that day.
 *   The bucket is dropped, not zero-filled — a zero-filled gap would drag the
 *   mean down and bias the inferred level (and therefore the calorie target)
 *   downward, which is the direction that matters least safely.
 * - PRESENT and zero (`sumQuantity: { quantity: 0 }`) means HealthKit measured
 *   and found nothing: a genuine sedentary day, and real evidence for the
 *   inference. This is the exact inverse of the absent case and is kept.
 */
export function dailyStepTotals(buckets: readonly StepStatisticsBucket[]): number[] {
  const totals: number[] = [];
  for (const bucket of buckets) {
    const q = bucket.sumQuantity?.quantity;
    if (typeof q !== "number" || !Number.isFinite(q) || q < 0) continue;
    totals.push(Math.round(q));
  }
  return totals;
}

/** Mean sessions per week from workout samples over a window of `days`. */
export function workoutsPerWeek(count: number, days: number): number {
  if (days <= 0) return 0;
  return (count / days) * 7;
}

/**
 * Opt-in Health read used by onboarding's activity question. Nothing happens
 * until `request()` is called — the permission dialog must not appear before the
 * user has chosen to share, and the manual card list stays the default path
 * (which is also what Android and every declining user gets).
 */
export function useActivityHistory(): ActivityHistory {
  const [status, setStatus] = useState<ActivityHistoryStatus>("idle");
  const [inference, setInference] = useState<ActivityInference | null>(null);

  const request = useCallback(() => {
    void (async () => {
      setStatus("loading");
      setInference(null);
      try {
        if (Platform.OS !== "ios") {
          setStatus("unavailable");
          return;
        }
        const hk = loadHealthKit();
        if (!hk.isHealthDataAvailable()) {
          setStatus("unavailable");
          return;
        }

        const granted = await hk.requestAuthorization({
          toRead: [STEP_COUNT_IDENTIFIER, WORKOUT_IDENTIFIER],
        });
        if (!granted) {
          setStatus("denied");
          return;
        }

        const now = new Date();
        const windowStart = new Date(startOfLocalDay(now) - (WINDOW_DAYS - 1) * MS_PER_DAY);

        const [stepBuckets, workouts] = await Promise.all([
          hk.queryStatisticsCollectionForQuantity(
            STEP_COUNT_IDENTIFIER,
            CUMULATIVE_SUM,
            // anchorDate: local midnight of windowStart, so each interval bucket
            // aligns to a local calendar day, matching startOfLocalDay semantics.
            windowStart,
            { day: 1 },
            { filter: { date: { startDate: windowStart, endDate: now } }, unit: "count" },
          ),
          hk.queryWorkoutSamples({
            filter: { date: { startDate: windowStart, endDate: now } },
            limit: 0,
          }),
        ]);

        const dailySteps = dailyStepTotals(stepBuckets);
        const result = inferActivityLevel({
          dailySteps,
          workoutsPerWeek: workoutsPerWeek(workouts.length, WINDOW_DAYS),
          daysObserved: dailySteps.length,
        });

        if (!result) {
          // Authorized but too thin to say anything honest. Distinct from
          // "denied" so the UI can explain it differently.
          setStatus("insufficient");
          return;
        }
        setInference(result);
        setStatus("ready");
      } catch {
        // Any HealthKit call can reject (missing native module, transient
        // bridge error). Degrade honestly — never leave a fabricated level.
        setStatus("unavailable");
        setInference(null);
      }
    })();
  }, []);

  return { status, inference, request };
}
