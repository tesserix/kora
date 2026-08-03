import { CACHED_MATCH_TIER } from "@/api/types";
import type { Candidate, FoodItem, Resolution } from "@/api/types";

// Adapters that dress a cached FoodItem up in the shapes the resolve and
// search screens already consume, so an offline lookup reuses the whole
// existing rendering path instead of growing a parallel one.
//
// Every field these synthesize is marked CACHED_MATCH_TIER. That marker is the
// point of this module: a cache hit must never be mistakable for a fresh
// server answer, because the two differ in what they actually know.

// Thrown when the device is offline AND the barcode is not one this device has
// resolved before. Distinct from a NetworkError: the request did not merely
// fail, we positively established we have no answer — so the copy can say
// "you have not scanned this one before" instead of "try again", which is
// advice that cannot work until the network returns.
export class OfflineUnknownBarcodeError extends Error {
  constructor() {
    super("offline: barcode not in the local cache");
    this.name = "OfflineUnknownBarcodeError";
  }
}

// A cached food has no server-computed kcal FOR THIS PORTION, and this client
// is forbidden from deriving nutrition (see src/lib/resolutionKcal.ts and
// capture.tsx's effectiveResolution). `kcal_unknown` is the existing, tested
// way to say exactly that: the row is loggable, contributes nothing to the
// displayed total, and renders "—". The server computes the real figure when
// the queued log drains.
//
// `tier: "confirm"` rather than "auto": the device is asserting an identity
// match on the barcode, not a confident nutritional resolution, so the user
// confirms before it is written.
export function resolutionFromCachedFood(item: FoodItem): Resolution {
  return {
    candidates: [
      {
        item,
        // A cached barcode record always came from a real server resolve
        // (getFoodByBarcode can only hit "full" fidelity entries), so its
        // serving is genuine. The 100g floor is for a record whose serving
        // was never populated — a portion of 0 would log nothing.
        portion_grams: item.serving_grams > 0 ? item.serving_grams : 100,
        kcal: 0,
        kcal_unknown: true,
        match_score: 1,
        match_tier: CACHED_MATCH_TIER,
        tier: "confirm",
      },
    ],
    tier: "confirm",
    is_estimate: false,
    provenance: CACHED_MATCH_TIER,
  };
}

// The search shape. `match_score: 1` is not a claim of quality — cached search
// is a plain name-substring filter with no ranking — it only keeps the field a
// number. `match_tier` is what callers must read to know where this came from.
export function candidatesFromCachedFoods(items: FoodItem[]): Candidate[] {
  return items.map((item) => ({ item, match_score: 1, match_tier: CACHED_MATCH_TIER }));
}
