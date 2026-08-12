import { resultSummary } from "../ResolutionResult";
import type { Resolution } from "@/api/types";

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    candidates: [
      {
        item: {
          id: "1",
          name: "Grilled chicken breast",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 breast",
          serving_grams: 140,
          kcal_per_100g: 165,
          protein_per_100g: 31,
          carbs_per_100g: 0,
          fat_per_100g: 3.6,
        },
        portion_grams: 140.4,
        kcal: 231.2,
        match_score: 0.958,
        match_tier: "auto",
      },
      {
        item: {
          id: "2",
          name: "Steamed broccoli",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 cup",
          serving_grams: 90,
          kcal_per_100g: 34,
          protein_per_100g: 2.8,
          carbs_per_100g: 7,
          fat_per_100g: 0.4,
        },
        portion_grams: 90.2,
        kcal: 30.6,
        match_score: 0.912,
        match_tier: "auto",
      },
    ],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
    ...overrides,
  };
}

test("the summary reflects the weakest row, not the first", () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: [
      { ...base.candidates[0], portion_assumed: false },
      { ...base.candidates[1], portion_assumed: true },
    ],
  };

  const summary = resultSummary(resolution);

  expect(summary).toMatch(/guess/i);
});

test("a summary with no assumed portions says nothing about guessing", () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: base.candidates.map((c) => ({ ...c, portion_assumed: false })),
  };

  const summary = resultSummary(resolution);

  expect(summary).not.toMatch(/guess/i);
});
