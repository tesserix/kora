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

/**
 * Buckets step samples into per-day totals across the window. Days with no
 * samples are genuinely absent rather than zero-filled — a zero-filled gap would
 * drag the mean down and bias the inferred level (and therefore the calorie
 * target) downward, which is the direction that matters least safely.
 */
export function bucketStepsByDay(
  samples: readonly { readonly startDate: Date; readonly quantity: number }[],
): number[] {
  const byDay = new Map<number, number>();
  for (const s of samples) {
    const day = startOfLocalDay(new Date(s.startDate));
    if (!Number.isFinite(day)) continue;
    const q = Number(s.quantity);
    if (!Number.isFinite(q) || q < 0) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + q);
  }
  return [...byDay.values()].map((n) => Math.round(n));
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

        const [stepSamples, workouts] = await Promise.all([
          hk.queryQuantitySamples(STEP_COUNT_IDENTIFIER, {
            filter: { date: { startDate: windowStart, endDate: now } },
            limit: 0,
            unit: "count",
          }),
          hk.queryWorkoutSamples({
            filter: { date: { startDate: windowStart, endDate: now } },
            limit: 0,
          }),
        ]);

        const dailySteps = bucketStepsByDay(stepSamples);
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
