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

/**
 * readDailyStepBuckets returns one bucket per day, in the shape
 * useActivityHistory's dailyStepTotals already parses.
 *
 * Health Connect OMITS a period with no data rather than returning a zeroed
 * group, which lines up exactly with the distinction that hook depends on: an
 * absent day is dropped, and a day it measured as zero is kept as real
 * evidence of a sedentary day. Zero-filling the gaps instead would drag the
 * mean down and bias the inferred activity level — and therefore the calorie
 * target — downward.
 */
export async function readDailyStepBuckets(
  start: Date,
  end: Date,
): Promise<{ startDate: Date; sumQuantity?: { unit: string; quantity: number } }[]> {
  try {
    const hc = loadHealthConnect();
    const groups = await hc.aggregateGroupByPeriod({
      recordType: "Steps",
      timeRangeFilter: { operator: "between", startTime: start.toISOString(), endTime: end.toISOString() },
      timeRangeSlicer: { period: "DAYS", length: 1 },
    });
    return groups.map((g) => {
      const total = (g.result as { COUNT_TOTAL?: number }).COUNT_TOTAL;
      return typeof total === "number" && Number.isFinite(total)
        ? { startDate: new Date(g.startTime), sumQuantity: { unit: "count", quantity: total } }
        : // Present as a bucket but with no measurement — the same "absent"
          // fact HealthKit expresses by omitting sumQuantity.
          { startDate: new Date(g.startTime) };
    });
  } catch {
    return [];
  }
}

/** One weight reading plus the token to resume from, mirroring HealthKit's anchor. */
export type WeightChanges = {
  readonly samples: { uuid: string; quantity: number; startDate: Date; sourceName: string }[];
  readonly newAnchor: string;
};

/**
 * readWeightChanges is the Android half of the anchored weight sync.
 *
 * Health Connect's CHANGES TOKEN is HealthKit's anchor: pass the last one back
 * and receive only what changed since. Passing none returns a fresh token,
 * which is the first-run baseline.
 *
 * # THROWS rather than returning empty, deliberately
 *
 * syncWeight only advances the stored anchor after this resolves, so a throw
 * leaves the anchor untouched and the next launch retries the same window —
 * the self-healing property the iOS path relies on. Returning an empty batch
 * instead would advance the anchor past readings that were never posted, and
 * they would be lost silently.
 *
 * `changesTokenExpired` is Health Connect telling us the token is too old to
 * resume from — the equivalent of a stale HealthKit anchor. Throwing forces
 * the caller to keep its old anchor and try again, rather than silently
 * skipping the gap.
 */
export async function readWeightChanges(anchor: string | null): Promise<WeightChanges> {
  const hc = loadHealthConnect();
  if (!(await isAvailable())) throw new Error("Health Connect unavailable");

  const result = await hc.getChanges(
    anchor ? { changesToken: anchor } : { recordTypes: ["Weight"] },
  );
  if (result.changesTokenExpired) {
    throw new Error("Health Connect changes token expired");
  }

  const samples: WeightChanges["samples"] = [];
  for (const change of result.upsertionChanges) {
    const record = change.record;
    if (record.recordType !== "Weight") continue;
    const kg = record.weight?.inKilograms;
    const id = record.metadata?.id;
    // A reading with no id cannot be de-duplicated server-side, and one with
    // no mass is not a reading. Both are dropped rather than posted as zero.
    if (typeof kg !== "number" || !Number.isFinite(kg) || !id) continue;
    samples.push({
      uuid: id,
      quantity: kg,
      startDate: new Date(record.time),
      sourceName: record.metadata?.dataOrigin ?? "",
    });
  }
  return { samples, newAnchor: result.nextChangesToken };
}

/**
 * requestActivityPermissions asks for the scopes useActivityHistory needs.
 *
 * Separate from requestPermissions because the two surfaces ask at different
 * moments and for different reasons — the Today tiles need steps and sleep,
 * the activity inference needs steps and exercise. Asking for everything at
 * the first prompt would put scopes in front of a user before anything on
 * screen explains why they are wanted.
 */
export async function requestActivityPermissions(): Promise<boolean> {
  try {
    const hc = loadHealthConnect();
    const granted = await hc.requestPermission([
      { accessType: "read", recordType: "Steps" },
      { accessType: "read", recordType: "ExerciseSession" },
    ]);
    const has = (recordType: string) =>
      granted.some((p) => "recordType" in p && p.recordType === recordType && p.accessType === "read");
    return has("Steps") && has("ExerciseSession");
  } catch {
    return false;
  }
}

/** Counts exercise sessions in a window, the Android analogue of workout samples. */
export async function readWorkoutCount(start: Date, end: Date): Promise<number> {
  try {
    const hc = loadHealthConnect();
    const { records } = await hc.readRecords("ExerciseSession", {
      timeRangeFilter: { operator: "between", startTime: start.toISOString(), endTime: end.toISOString() },
    });
    return records.length;
  } catch {
    return 0;
  }
}

/**
 * hasWeightPermission reports whether the Weight read scope is already
 * granted.
 *
 * Android answers a genuinely different question from iOS. HealthKit hides
 * read authorization (an app that could tell granted from denied could infer
 * the existence of data the user withheld), so iOS can only ask "has a sheet
 * been shown". Health Connect answers directly.
 *
 * Both are used for the same purpose — never prompt from a background path —
 * and for that purpose the answers are interchangeable: a granted scope means
 * the user has already been asked.
 */
export async function hasWeightPermission(): Promise<boolean> {
  try {
    const hc = loadHealthConnect();
    if (!(await isAvailable())) return false;
    const granted = await hc.getGrantedPermissions();
    return granted.some(
      (p) => "recordType" in p && p.recordType === "Weight" && p.accessType === "read",
    );
  } catch {
    return false;
  }
}

/** Shows the Health Connect permission UI for weight reads. */
export async function requestWeightPermission(): Promise<void> {
  try {
    const hc = loadHealthConnect();
    await hc.requestPermission([{ accessType: "read", recordType: "Weight" }]);
  } catch {
    // Swallowed to match the iOS contract: this reports that the REQUEST
    // completed, never that reads were granted. A caller must not treat it
    // resolving as permission to expect data.
  }
}
