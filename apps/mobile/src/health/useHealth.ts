import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
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

// KNOWN LIMITATION, not fixed here (#327): this window runs from 08:00 the
// PREVIOUS day to now, so it will absorb a nap taken yesterday morning or
// afternoon, or any nap taken today, into a total labelled "last night's
// sleep". Interval merging (below) fixes the double-counting bug but cannot
// fix this — it is a product decision (narrow the window, or relabel the
// field as something like "sleep in the last 16h") deliberately left for a
// separate change, not bundled into this bug fix.
const SLEEP_WINDOW_LOOKBACK_HOURS = 16;
const MS_PER_HOUR = 60 * 60 * 1000;

// How far back to look for ANY step sample before concluding reads are not
// working. "No steps today" is normal every morning; "no steps in a week" is
// evidence. See the spec's "empty-day trap".
const READABLE_PROBE_DAYS = 7;

// Today's total is read as a CUMULATIVE SUM statistic, never by summing raw samples.
// queryQuantitySamples returns every source's samples — iPhone, Apple Watch, and any
// third-party app — with no deduplication, so a Watch user's total came out inflated
// and disagreed both with the Health app and with Kora's own widget. Only a statistics
// query applies HealthKit's source-priority dedup. targets/kora-widgets/HealthReader.swift
// already does exactly this (HKStatisticsQuery with .cumulativeSum); this mirrors it.
const CUMULATIVE_SUM: readonly ["cumulativeSum"] = ["cumulativeSum"];

function startOfLocalDay(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

type AsleepSample = {
  readonly value: number;
  readonly startDate: Date;
  readonly endDate: Date;
};

// Interval union, not a sum. queryCategorySamples — like queryQuantitySamples for
// steps above — returns every writing source's raw samples with no dedup, and
// HKStatisticsQuery (the fix used for steps) only works on QUANTITY types; sleep
// is a CATEGORY type, so that trick isn't available here (see #327). Worse, sleep
// has a second failure mode steps doesn't: even a SINGLE source's samples overlap
// each other, because sources describe the night at different granularity — a
// third-party app writes one `asleepUnspecified` block for the whole night while
// Apple Watch writes Core/Deep/REM samples layered across that same span. Summing
// raw durations counts both in full (~7h unspecified + ~6h staged = the reported
// 12.8h). Merging overlapping/adjacent intervals first and summing the union
// measures TIME ASLEEP rather than THE SUM OF CLAIMS ABOUT TIME ASLEEP, which is
// correct no matter how many sources write or how finely each one buckets stages.
//
// Deliberately keeps `asleepUnspecified` (1) in the union instead of dropping it
// whenever staged (3/4/5) samples are also present. A source that only ever
// writes unspecified blocks can cover minutes no staged sample touches — partial
// Watch battery coverage, a stretch where only the third-party app was running —
// and dropping unspecified outright would silently UNDER-count exactly those
// minutes. Merging makes inclusion free when coverage matches (the spans just
// collapse to one interval) and correct when it doesn't. A future "time in deep
// sleep" readout can filter to staged-only values on its own path; it does not
// need this total to have dropped unspecified first.
export function mergeAsleepMillis(samples: readonly AsleepSample[]): number {
  const intervals = samples
    .filter((sample) => ASLEEP_CATEGORY_VALUES.has(sample.value))
    .map((sample) => ({
      start: new Date(sample.startDate).getTime(),
      end: new Date(sample.endDate).getTime(),
    }))
    // Drop unparseable dates and zero/negative-duration samples up front so the
    // sweep below never has to special-case them.
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  let totalMillis = 0;
  let runStart: number | null = null;
  let runEnd: number | null = null;

  for (const interval of intervals) {
    if (runStart === null || runEnd === null) {
      runStart = interval.start;
      runEnd = interval.end;
      continue;
    }
    if (interval.start <= runEnd) {
      // Overlaps, or touches exactly (one ends the instant the next begins) —
      // both describe one continuous span of sleep, so extend the run rather
      // than double-counting the shared or adjoining minutes.
      runEnd = Math.max(runEnd, interval.end);
      continue;
    }
    // A genuine gap (interval.start > runEnd): close out the run and start a new one.
    totalMillis += runEnd - runStart;
    runStart = interval.start;
    runEnd = interval.end;
  }
  if (runStart !== null && runEnd !== null) {
    totalMillis += runEnd - runStart;
  }
  return totalMillis;
}

/**
 * Client-only health signal for the Home dashboard: today's steps and last night's sleep,
 * read directly from Apple HealthKit on-device. No backend call, no persistence — this
 * hook only ever reflects live HealthKit state for the current session.
 *
 * It re-reads on return to the foreground, on screen focus, and on demand via
 * `refresh()`. That is not an optimisation: Expo Router keeps Home mounted for the
 * whole session, so a mount-only read is frozen for as long as the app stays open.
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

  // Guards against two loads overlapping. Foreground and focus land within
  // milliseconds of each other on a real tab switch, and two in-flight reads could
  // interleave their setState calls and leave the OLDER answer on screen. A ref,
  // not state: this must be readable and writable synchronously inside load(),
  // before React has any chance to re-render.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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

      const [stepStats, sleepSamples] = await Promise.all([
        hk.queryStatisticsForQuantity(STEP_COUNT_IDENTIFIER, CUMULATIVE_SUM, {
          // strictStartDate keeps a sample that spans midnight from being counted in
          // full toward today — HealthKit's default predicate includes any sample
          // merely overlapping the window.
          filter: { date: { startDate: dayStart, endDate: now, strictStartDate: true } },
          unit: "count",
        }),
        hk.queryCategorySamples(SLEEP_ANALYSIS_IDENTIFIER, {
          filter: { date: { startDate: sleepWindowStart, endDate: now } },
          limit: 0,
        }),
      ]);

      // An ABSENT sumQuantity for today alone is ambiguous: no movement yet, or no
      // read access — HealthKit will not say which, and "no steps today" is simply
      // what every morning looks like before the user walks. Probe a wider window
      // before concluding access is broken. A sum that is PRESENT and zero is a
      // different fact (HealthKit measured and found nothing) and is a real 0.
      const stepTotal = stepStats?.sumQuantity?.quantity;
      if (typeof stepTotal === "number" && Number.isFinite(stepTotal)) {
        setSteps({ today: Math.round(stepTotal), goal: STEP_GOAL });
      } else {
        // Today is empty. Probe a wider window to tell "hasn't walked yet"
        // from "cannot read" — HealthKit will not tell us which directly.
        // Raw samples are the right tool here and multi-source inflation does not
        // matter: this asks only "does ANY step sample exist", never how many.
        const probeStart = new Date(dayStart.getTime() - READABLE_PROBE_DAYS * 24 * MS_PER_HOUR);
        const weekSamples = await hk.queryQuantitySamples(STEP_COUNT_IDENTIFIER, {
          filter: { date: { startDate: probeStart, endDate: now } },
          limit: 0,
          unit: "count",
        });
        setSteps(weekSamples.length > 0 ? { today: 0, goal: STEP_GOAL } : null);
      }
      const sleepMillis = mergeAsleepMillis(sleepSamples);
      // Stored at full precision, rounded once at render by
      // sleepDurationLabel. Rounding to one decimal HERE quantised the night
      // to 6-minute steps, so 4h 26m was stored as 4.4 and could only ever be
      // rendered back as 4h 24m -- a two-minute error created by the store,
      // not by the measurement.
      setSleep(sleepSamples.length > 0 ? { lastNightHours: sleepMillis / MS_PER_HOUR } : null);
      setStatus("authorized");
    } catch {
      // Any HealthKit call (authorization request or either query) can reject —
      // e.g. a transient native-bridge error. Degrade honestly instead of
      // crashing or leaving a stale/fabricated number on screen.
      setStatus("unavailable");
      setSteps(null);
      setSleep(null);
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Cold start. Every early `return` above still releases the guard via `finally`,
  // so a load that bails on a non-iOS platform does not wedge later triggers.
  useEffect(() => {
    void load();
  }, [load]);

  // Return to foreground. Without this the reported bug: Expo Router keeps Home
  // mounted for the whole session, so a mount-only read froze whatever HealthKit
  // said at launch — a user who opened Kora at ~1,000 steps and then walked all
  // day kept reading "1,000". Mirrors the AppState pattern in app/_layout.tsx and
  // src/offline/drainTriggers.ts: one subscription, removed on unmount.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => sub.remove();
  }, [load]);

  // Return to the screen. Foreground alone misses the far more common case:
  // walking with the app open, then switching back to the Home tab.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Always route to Health. The old `status === "denied"` guard was unreachable
  // (see the spec), which left a denied user with no way to grant access.
  const connect = useCallback(() => {
    void Linking.openURL("x-apple-health://");
    void load();
  }, [load]);

  return { status, steps, sleep, connect, refresh: load };
}

/**
 * Whether to offer "Connect Apple Health" (kora#406).
 *
 * The bug this exists to prevent: three screens branched on whether the
 * DATA existed, so "connected, but nothing recorded for this period"
 * rendered the same prompt as "never connected". An already-connected user
 * was sent into a permission flow that fixes nothing — the figure still
 * would not appear, because the real reason is that no measurement exists.
 *
 * Absence of a measurement is not absence of permission. `denied` and
 * `unavailable` both DO warrant the prompt: for those, granting access is
 * genuinely the remedy.
 */
export function shouldOfferConnect(status: HealthStatus): boolean {
  return status !== "authorized";
}
