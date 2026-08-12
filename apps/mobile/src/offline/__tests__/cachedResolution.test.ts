import { resolutionFromCachedFood } from "../cachedResolution";
import type { FoodItem } from "@/api/types";

function food(overrides: Partial<FoodItem> = {}): FoodItem {
  return {
    id: "f1", name: "Greek yogurt", brand: "", provenance: "usda",
    serving_desc: "150 g", serving_grams: 150,
    kcal_per_100g: 100, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
    ...overrides,
  };
}

// Pins the client-side twin of the Go `barcodeCandidate` predicate
// (`item.ServingGrams <= 0` in api/internal/resolve/handler.go): a cached
// record with a real serving must not be flagged as assumed, or the UI would
// hedge a genuine measurement.
test("real serving_grams yields portion_assumed: false", () => {
  const resolution = resolutionFromCachedFood(food({ serving_grams: 150 }));
  expect(resolution.candidates[0].portion_assumed).toBe(false);
  expect(resolution.candidates[0].portion_grams).toBe(150);
});

// The counterpart: a record whose serving was never populated on the server
// falls back to the 100g floor, and that fallback must be flagged so it never
// renders like a known measurement (see comment above `portion_assumed` in
// cachedResolution.ts).
test("missing serving_grams yields portion_assumed: true and the 100g floor", () => {
  const resolution = resolutionFromCachedFood(food({ serving_grams: 0 }));
  expect(resolution.candidates[0].portion_assumed).toBe(true);
  expect(resolution.candidates[0].portion_grams).toBe(100);
});
