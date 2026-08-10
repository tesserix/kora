import { apiFetch } from "@/lib/api";
import type { WeightEntry } from "@/api/types";

// fetchLatestWeighInDate looks back a year for the most recent weigh-in —
// wide enough to cover any real usage pattern while still bounding the
// query. Shared by every caller that needs "did the user already weigh in":
// the foreground reconciliation listener (app/_layout.tsx), and the meal/
// custom reminder hooks, which must pass the real last weigh-in date rather
// than a stale `null` placeholder whenever they re-sync the OS schedule.
//
// Never rejects. A failed fetch is treated as "no recent weigh-in" so the
// weight reminder still fires — a redundant reminder is a nuisance, a
// silently suppressed one defeats the feature.
export async function fetchLatestWeighInDate(): Promise<Date | null> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const entries = (await apiFetch(
      `/v1/weight?from=${from.toISOString()}&to=${to.toISOString()}`,
    )) as WeightEntry[];
    if (entries.length === 0) return null;
    return new Date(entries[entries.length - 1].logged_at);
  } catch {
    return null;
  }
}
