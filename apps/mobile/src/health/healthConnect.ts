// Android health data, via Health Connect (kora#417 follow-on).
//
// The iOS path reads HealthKit directly in useHealth. This module is the
// Android half, kept behind the same shape so the hook branches once on
// Platform.OS and nothing downstream knows which platform answered.
//
// Loaded lazily, exactly like loadHealthKit: react-native-health-connect is a
// native module and importing it at module scope on a build without the native
// side linked throws before any try/catch can run.

import type { AsleepSample } from "./useHealth";

/** What the hook needs, whichever platform supplies it. */
export type AndroidHealthReading = {
  /** Steps today, already deduplicated across sources by Health Connect. */
  readonly steps: number | null;
  /** Merged asleep intervals for the most recent sleep session. */
  readonly sleepSamples: readonly AsleepSample[];
};

type HealthConnectModule = typeof import("react-native-health-connect");

let cached: HealthConnectModule | null = null;

function loadHealthConnect(): HealthConnectModule {
  if (!cached) cached = require("react-native-health-connect") as HealthConnectModule;
  return cached;
}

// Stages that mean ASLEEP. Mirrors ASLEEP_CATEGORY_VALUES on the iOS side:
// AWAKE and OUT_OF_BED are time in a session but NOT time asleep, and counting
// them is the difference between Kora's figure and the platform's own.
// UNKNOWN is excluded for the same reason it is on iOS — a stage the source
// could not classify is not evidence of sleep.
const ASLEEP_STAGES = new Set<number>([2 /* SLEEPING */, 4 /* LIGHT */, 5 /* DEEP */, 6 /* REM */]);

/**
 * isAvailable reports whether Health Connect can be used at all.
 *
 * Three distinct answers collapse to false here, and the caller renders them
 * identically as "unavailable": the SDK is absent (Health Connect is not
 * installed — it ships with Android 14+, and is a Play Store download below
 * that), the provider needs an update, or the native module is not linked.
 * None of them is a permission problem, and offering a permission prompt for
 * any of them would send the user somewhere that cannot help.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const hc = loadHealthConnect();
    const status = await hc.getSdkStatus();
    if (status !== hc.SdkAvailabilityStatus.SDK_AVAILABLE) return false;
    return await hc.initialize();
  } catch {
    return false;
  }
}

/**
 * requestPermissions asks for the read scopes Kora uses.
 *
 * Returns whether STEPS and SLEEP were both granted, because those are what
 * the Today surface renders. Health Connect grants per record type, so a user
 * can approve one and decline the other — treating a partial grant as success
 * would leave a tile permanently empty with nothing explaining why.
 */
export async function requestPermissions(): Promise<boolean> {
  try {
    const hc = loadHealthConnect();
    const granted = await hc.requestPermission([
      { accessType: "read", recordType: "Steps" },
      { accessType: "read", recordType: "SleepSession" },
    ]);
    const has = (recordType: string) =>
      granted.some((p) => "recordType" in p && p.recordType === recordType && p.accessType === "read");
    return has("Steps") && has("SleepSession");
  } catch {
    return false;
  }
}

/**
 * readSteps returns today's step total.
 *
 * Uses aggregateRecord, never a sum over raw records, for the same reason the
 * iOS path uses a statistics query: raw records are per-source, so a user with
 * both a phone and a watch double-counts. Aggregation applies Health Connect's
 * own de-duplication.
 *
 * null means "could not measure", never 0 — the caller distinguishes an
 * unmeasured day from a genuinely still one.
 */
export async function readSteps(dayStart: Date, now: Date): Promise<number | null> {
  try {
    const hc = loadHealthConnect();
    const result = await hc.aggregateRecord({
      recordType: "Steps",
      timeRangeFilter: {
        operator: "between",
        startTime: dayStart.toISOString(),
        endTime: now.toISOString(),
      },
    });
    const total = (result as { COUNT_TOTAL?: number }).COUNT_TOTAL;
    return typeof total === "number" && Number.isFinite(total) ? Math.round(total) : null;
  } catch {
    return null;
  }
}

/**
 * readSleepSamples returns the asleep intervals of the MOST RECENT sleep
 * session, as the same {value,startDate,endDate} shape the iOS path produces —
 * so mergeAsleepMillis does the arithmetic for both platforms.
 *
 * # Why the session, not Apple's 18:00 day
 *
 * iOS has to RECONSTRUCT a night: HealthKit hands over loose samples, so
 * useHealth buckets them by Apple's 18:00 -> 18:00 sleep day to work out which
 * ones belong together. Health Connect models the night directly as a
 * SleepSessionRecord, so the reconstruction is unnecessary here — and applying
 * it anyway would be worse, splitting a genuine session that happened to
 * straddle 18:00.
 *
 * Both platforms therefore report the same CONCEPT — the most recent night —
 * derived the way each platform actually represents it.
 *
 * Sessions without stages fall back to the session's own span. Some sources
 * write only a start and end; treating that as zero would erase a night that
 * was genuinely recorded, just less precisely.
 */
export async function readSleepSamples(since: Date, now: Date): Promise<AsleepSample[]> {
  try {
    const hc = loadHealthConnect();
    const { records } = await hc.readRecords("SleepSession", {
      timeRangeFilter: {
        operator: "between",
        startTime: since.toISOString(),
        endTime: now.toISOString(),
      },
    });
    if (records.length === 0) return [];

    // Most recent by END time: a session that started earlier but ended later
    // is the more recent night.
    const latest = records.reduce((best, r) =>
      new Date(r.endTime).getTime() > new Date(best.endTime).getTime() ? r : best,
    );

    const stages = latest.stages ?? [];
    if (stages.length === 0) {
      return [{ value: 1, startDate: new Date(latest.startTime), endDate: new Date(latest.endTime) }];
    }
    return stages
      .filter((s) => ASLEEP_STAGES.has(s.stage))
      .map((s) => ({ value: 1, startDate: new Date(s.startTime), endDate: new Date(s.endTime) }));
  } catch {
    return [];
  }
}
