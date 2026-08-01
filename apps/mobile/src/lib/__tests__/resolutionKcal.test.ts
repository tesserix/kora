import { kcalTotalLabel } from "../resolutionKcal";
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

describe("kcalTotalLabel", () => {
  test("sums candidate kcal when not an estimate", () => {
    // 231.2 + 30.6 = 261.8 -> rounds to 262
    expect(kcalTotalLabel(makeResolution({ is_estimate: false }))).toBe("262 kcal");
  });

  test("renders an en-dash range when it is an estimate", () => {
    const resolution = makeResolution({ is_estimate: true, kcal_low: 380, kcal_high: 440 });
    expect(kcalTotalLabel(resolution)).toBe("380–440 kcal");
  });

  test("defaults missing kcal_low/kcal_high to 0 for an estimate", () => {
    const resolution = makeResolution({ is_estimate: true, kcal_low: undefined, kcal_high: undefined });
    expect(kcalTotalLabel(resolution)).toBe("0–0 kcal");
  });

  test("the header total ignores items that will not be logged", () => {
    const resolution = {
      is_estimate: false,
      candidates: [
        { item: { id: "a" }, portion_grams: 100, kcal: 200, match_score: 0.95, match_tier: "alias", tier: "auto" },
        { item: { id: "b" }, portion_grams: 100, kcal: 500, match_score: 0.3, match_tier: "embedding", tier: "follow_up" },
      ],
    } as unknown as Resolution;
    expect(kcalTotalLabel(resolution)).toBe("200 kcal");
  });
});
