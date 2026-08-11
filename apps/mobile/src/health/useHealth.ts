import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import type { HealthData, HealthStatus } from "./types";

// `@kingstinct/react-native-healthkit` is a Nitro native module that throws at
// IMPORT time on any build where the native side isn't linked (e.g. a dev client
// built before HealthKit was added). A static top-level import would crash the
// whole screen before any try/catch can run. Requiring it lazily inside the
// guarded load() defers that to call time, where the try/catch turns a missing
// module into an honest "unavailable" state instead of a redbox.
type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");
function loadHealthKit(): HealthKitModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kingstinct/react-native-healthkit") as HealthKitModule;
}

export const STEP_GOAL = 10000;

// HealthKit type identifiers this hook reads. Declared as bare `const` (no type
// annotation) so TypeScript infers the narrow string-literal type each HealthKit call
// expects, instead of the wide QuantityTypeIdentifier / CategoryTypeIdentifier unions —
// that's what lets `unit: "count"` below type-check against the step-count-specific unit.
const STEP_COUNT_IDENTIFIER = "HKQuantityTypeIdentifierStepCount";
const SLEEP_ANALYSIS_IDENTIFIER = "HKCategoryTypeIdentifierSleepAnalysis";

// HealthKit's CategoryValueSleepAnalysis enum: inBed=0, asleepUnspecified/asleep=1,
// awake=2, asleepCore=3, asleepDeep=4, asleepREM=5. "In bed" and "awake" samples are
// excluded — only genuine sleep stages count toward the total.
const ASLEEP_CATEGORY_VALUES = new Set<number>([1, 3, 4, 5]);

const SLEEP_WINDOW_LOOKBACK_HOURS = 16;
const MS_PER_HOUR = 60 * 60 * 1000;

// How far back to look for ANY step sample before concluding reads are not
// working. "No steps today" is normal every morning; "no steps in a week" is
// evidence. See the spec's "empty-day trap".
const READABLE_PROBE_DAYS = 7;

function startOfLocalDay(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

function sumSteps(samples: readonly { readonly quantity: number }[]): number {
  return samples.reduce((total, sample) => total + sample.quantity, 0);
}

function sumAsleepMillis(
  samples: readonly {
    readonly value: number;
    readonly startDate: Date;
    readonly endDate: Date;
  }[],
): number {
  return samples.reduce((total, sample) => {
    if (!ASLEEP_CATEGORY_VALUES.has(sample.value)) return total;
    const start = new Date(sample.startDate).getTime();
    const end = new Date(sample.endDate).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return total;
    return total + Math.max(0, end - start);
  }, 0);
}

/**
 * Client-only health signal for the Home dashboard: today's steps and last night's sleep,
 * read directly from Apple HealthKit on-device. No backend call, no persistence — this
 * hook only ever reflects live HealthKit state for the current session.
 *
 * Degrades honestly through three `status` states, but `status` alone cannot be trusted
 * to gate the UI: HealthKit's `requestAuthorization` resolves successfully once the
 * READ prompt was merely *presented*, never disclosing whether the user actually granted
 * read access. So `status === "authorized"` means only "the prompt was shown, and the
 * WRITE half (if any) succeeded" — a denied read looks identical and still queries
 * successfully, just returning an empty array indistinguishable from "genuinely no data
 * yet". Callers must therefore treat `steps`/`sleep` themselves — non-null only when a
 * sample was actually readable — as the source of truth, not `status`:
 * - "unavailable": non-iOS device, or HealthKit itself isn't available (e.g. simulator).
 * - "denied": `requestAuthorization` itself rejected/returned false — rare, but handled.
 * - "authorized": the request resolved; `steps`/`sleep` are set from real samples when
 *   any were readable, and left `null` (never a fabricated `0`) otherwise.
 */
export function useHealth(): HealthData {
  const [status, setStatus] = useState<HealthStatus>("unavailable");
  const [steps, setSteps] = useState<HealthData["steps"]>(null);
  const [sleep, setSleep] = useState<HealthData["sleep"]>(null);

  const load = useCallback(async () => {
    try {
      // TODO(health-connect): Android provider. This hook only supports iOS/HealthKit
      // today. When Android support lands, branch on Platform.OS === "android" here and
      // read from Health Connect instead, while keeping the same HealthData contract.
      // `isHealthDataAvailable()` is a native (Nitro) call, so it lives inside the
      // try/catch too: on a build where the native module isn't linked (e.g. a
      // dev-client built before HealthKit was added), it throws — degrade to
      // "unavailable" rather than crashing the screen.
      if (Platform.OS !== "ios") {
        setStatus("unavailable");
        setSteps(null);
        setSleep(null);
        return;
      }

      const hk = loadHealthKit();
      if (!hk.isHealthDataAvailable()) {
        setStatus("unavailable");
        setSteps(null);
        setSleep(null);
        return;
      }

      const granted = await hk.requestAuthorization({
        toRead: [STEP_COUNT_IDENTIFIER, SLEEP_ANALYSIS_IDENTIFIER],
      });
      if (!granted) {
        setStatus("denied");
        setSteps(null);
        setSleep(null);
        return;
      }

      const dayStart = startOfLocalDay();
      const now = new Date();
      const sleepWindowStart = new Date(dayStart.getTime() - SLEEP_WINDOW_LOOKBACK_HOURS * MS_PER_HOUR);

      const [stepSamples, sleepSamples] = await Promise.all([
        hk.queryQuantitySamples(STEP_COUNT_IDENTIFIER, {
          filter: { date: { startDate: dayStart, endDate: now } },
          limit: 0,
          unit: "count",
        }),
        hk.queryCategorySamples(SLEEP_ANALYSIS_IDENTIFIER, {
          filter: { date: { startDate: sleepWindowStart, endDate: now } },
          limit: 0,
        }),
      ]);

      // An empty sample array for today alone is ambiguous: no movement yet, or
      // no read access — HealthKit will not say which, and "no steps today" is
      // simply what every morning looks like before the user walks. Probe a
      // wider window before concluding access is broken.
      const stepTotal = sumSteps(stepSamples);
      if (stepSamples.length > 0) {
        setSteps({ today: Math.round(stepTotal), goal: STEP_GOAL });
      } else {
        // Today is empty. Probe a wider window to tell "hasn't walked yet"
        // from "cannot read" — HealthKit will not tell us which directly.
        const probeStart = new Date(dayStart.getTime() - READABLE_PROBE_DAYS * 24 * MS_PER_HOUR);
        const weekSamples = await hk.queryQuantitySamples(STEP_COUNT_IDENTIFIER, {
          filter: { date: { startDate: probeStart, endDate: now } },
          limit: 0,
          unit: "count",
        });
        setSteps(weekSamples.length > 0 ? { today: 0, goal: STEP_GOAL } : null);
      }
      const sleepMillis = sumAsleepMillis(sleepSamples);
      setSleep(sleepSamples.length > 0 ? { lastNightHours: Math.round((sleepMillis / MS_PER_HOUR) * 10) / 10 } : null);
      setStatus("authorized");
    } catch {
      // Any HealthKit call (authorization request or either query) can reject —
      // e.g. a transient native-bridge error. Degrade honestly instead of
      // crashing or leaving a stale/fabricated number on screen.
      setStatus("unavailable");
      setSteps(null);
      setSleep(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Always route to Health. The old `status === "denied"` guard was unreachable
  // (see the spec), which left a denied user with no way to grant access.
  const connect = useCallback(() => {
    void Linking.openURL("x-apple-health://");
    void load();
  }, [load]);

  return { status, steps, sleep, connect };
}
