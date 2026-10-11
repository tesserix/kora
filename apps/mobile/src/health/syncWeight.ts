import { localDateOf } from "@/lib/localDate";
import type { HealthMetric } from "./anchorStore";

// The shape syncWeight needs from a HealthKit body-mass sample. Deliberately
// narrower than the raw `@kingstinct/react-native-healthkit` sample type
// (see useHealthSync.ts for that mapping) so this module -- and its tests --
// never import HealthKit at all.
export type WeightSample = {
  uuid: string;
  quantity: number; // kilograms
  startDate: Date;
  sourceName: string;
};

// The body POST /v1/health/sync expects, one per HealthKit sample. Field
// names match the server's contract verbatim (kora#30 tasks 1-6).
export type WeightRecord = {
  hk_uuid: string;
  weight_kg: number;
  recorded_at: string;
  local_date: string;
  source_name: string;
};

export type WeightSyncRejection = { hk_uuid: string; reason: string };

export type WeightSyncResponse = {
  accepted: number;
  rejected: WeightSyncRejection[];
};

export type SyncWeightResult = { accepted: number; rejected: number };

export type SyncWeightDeps = {
  queryWeights: (
    anchor: string | null,
  ) => Promise<{ samples: WeightSample[]; newAnchor: string }>;
  post: (weights: WeightRecord[]) => Promise<WeightSyncResponse>;
  readAnchor: (metric: HealthMetric) => Promise<string | null>;
  writeAnchor: (metric: HealthMetric, anchor: string) => Promise<void>;
};

const METRIC: HealthMetric = "weight";

function toWeightRecord(sample: WeightSample): WeightRecord {
  return {
    hk_uuid: sample.uuid,
    weight_kg: sample.quantity,
    recorded_at: sample.startDate.toISOString(),
    // Device-zone date of the SAMPLE, not of now: a reading synced hours or
    // days after it was taken must still file under the day the user
    // actually stepped on the scale (kora#84).
    local_date: localDateOf(sample.startDate),
    source_name: sample.sourceName,
  };
}

// syncWeight reads the stored anchor, asks HealthKit (via deps) for
// everything new since it, posts that batch, and only then advances the
// anchor.
//
// The anchor is what makes a failed sync self-healing: leave it where it was
// and the next launch re-sends the same window. Advancing it on failure would
// skip those samples permanently -- there is no second chance, because an
// anchored query only ever moves forward. So `writeAnchor` runs strictly
// AFTER `post` resolves, never before and never in a `finally`.
export async function syncWeight(deps: SyncWeightDeps): Promise<SyncWeightResult> {
  const anchor = await deps.readAnchor(METRIC);
  const { samples, newAnchor } = await deps.queryWeights(anchor);

  if (samples.length === 0) {
    // No new samples, but HealthKit still hands back a fresh cursor -- moving
    // to it now is safe (there is nothing to lose) and keeps the next
    // launch's query from re-scanning the same empty window.
    await deps.writeAnchor(METRIC, newAnchor);
    return { accepted: 0, rejected: 0 };
  }

  const response = await deps.post(samples.map(toWeightRecord));

  // See the module comment: this line must stay after `post` resolves.
  await deps.writeAnchor(METRIC, newAnchor);

  return { accepted: response.accepted, rejected: response.rejected.length };
}
