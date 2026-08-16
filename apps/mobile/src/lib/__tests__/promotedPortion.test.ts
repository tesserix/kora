import { initialPortionFor } from "../promotedPortion";
import type { FoodItem } from "@/api/types";

function item(overrides: Partial<FoodItem> = {}): FoodItem {
  return {
    id: "x",
    name: "Test food",
    brand: "",
    provenance: "afcd",
    serving_desc: "",
    serving_grams: 0,
    kcal_per_100g: 100,
    protein_per_100g: 1,
    carbs_per_100g: 1,
    fat_per_100g: 1,
    ...overrides,
  } as FoodItem;
}

test("a food's own serving is used, and is not an assumption", () => {
  expect(initialPortionFor(item({ serving_grams: 150 }))).toEqual({ grams: 150, assumed: false });
});

test("no serving falls back to 100 g, flagged as assumed", () => {
  expect(initialPortionFor(item({ serving_grams: 0 }))).toEqual({ grams: 100, assumed: true });
});

// The bounds deliberately match the server's plausibleServingGrams
// (api/internal/ai/portion.go). A USDA reference mass like "Turkey, whole"
// (5717 g) is a whole-animal figure, not a portion — accepting it here would
// show a portion the diary then disagrees with, since the server would reject
// the same value.
test("an implausible serving is rejected in favour of the default", () => {
  expect(initialPortionFor(item({ serving_grams: 5717 }))).toEqual({ grams: 100, assumed: true });
  expect(initialPortionFor(item({ serving_grams: 0.4 }))).toEqual({ grams: 100, assumed: true });
});

test("the bounds themselves are inclusive", () => {
  expect(initialPortionFor(item({ serving_grams: 1 })).grams).toBe(1);
  expect(initialPortionFor(item({ serving_grams: 500 })).grams).toBe(500);
  expect(initialPortionFor(item({ serving_grams: 501 })).grams).toBe(100);
});
