import AsyncStorage from "@react-native-async-storage/async-storage";

// The only metric this syncs today. Kept as a union (not a bare string) so a
// second metric added later is a type-checked decision at every call site,
// not a silent string that happens to work.
export type HealthMetric = "weight";

// Per-metric key: `readAnchor("weight")` must never see what
// `writeAnchor("steps", ...)` wrote. Without the metric in the key, adding a
// second synced metric later would have it silently resume (or skip) from
// the wrong cursor.
function key(metric: HealthMetric): string {
  return `kora.health.anchor.${metric}`;
}

// The anchor is DEVICE state, never server state: HKAnchoredObjectQuery
// returns an opaque cursor meaningful only to this device's HealthKit store.
// Sending it to the server would break the moment the user signs in on a
// second phone, which would resume from a cursor that means nothing to it and
// silently skip everything before it. So this is plain AsyncStorage, the same
// local-only store the rest of the offline layer already uses (see
// src/offline/queue.ts, src/offline/owner.ts) — not queued, not synced.
export async function readAnchor(metric: HealthMetric): Promise<string | null> {
  return AsyncStorage.getItem(key(metric));
}

export async function writeAnchor(metric: HealthMetric, anchor: string): Promise<void> {
  await AsyncStorage.setItem(key(metric), anchor);
}
