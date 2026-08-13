import { resultSummary } from "../ResolutionResult";
import { CACHED_MATCH_TIER } from "@/api/types";
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

  expect(summary).toMatch(/one portion is a guess/i);
});

test("the summary reflects the actual assumed-portion count, not just presence", () => {
  const base = makeResolution();
  const resolution: Resolution = {
    ...base,
    candidates: [
      { ...base.candidates[0], portion_assumed: true },
      { ...base.candidates[1], portion_assumed: true },
      { ...base.candidates[0], item: { ...base.candidates[0].item, id: "3" }, portion_assumed: true },
      { ...base.candidates[1], item: { ...base.candidates[1].item, id: "4" }, portion_assumed: false },
    ],
  };

  const summary = resultSummary(resolution);

  expect(summary).toMatch(/3 portions are guesses/i);
  expect(summary).not.toMatch(/one portion is a guess/i);
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

// The cached branch used to return before the assumedCount hedging below it,
// so an offline barcode hit with a system-guessed portion read as an exact
// figure. This pair pins the bug: hedge when the cached candidate demands it,
// and leave the existing unhedged copy alone otherwise.
test("a cached resolution with an assumed candidate hedges the summary", () => {
  const base = makeResolution();
  const resolution: Resolution = {
    ...base,
    provenance: CACHED_MATCH_TIER,
    candidates: [{ ...base.candidates[0], portion_assumed: true }],
  };

  const summary = resultSummary(resolution);

  expect(summary).toMatch(/from a scan you.{0,3}ve done before/i);
  expect(summary).toMatch(/one portion is a guess/i);
});

test("a cached resolution with no assumed candidate keeps the existing unhedged copy", () => {
  const base = makeResolution();
  const resolution: Resolution = {
    ...base,
    provenance: CACHED_MATCH_TIER,
    candidates: [{ ...base.candidates[0], portion_assumed: false }],
  };

  const summary = resultSummary(resolution);

  expect(summary).toMatch(/from a scan you.{0,3}ve done before/i);
  expect(summary).not.toMatch(/guess/i);
});
