import type { WeightEntry } from "@/api/types";
import {
  COMPOSITION_METRICS,
  MANUAL_SOURCES,
  compositionMetric,
  displayNumber,
  formatMetricNumber,
  metricAccessibilityLabel,
  metricValue,
  sourceLabel,
  unitLabel,
} from "../bodyCompositionFields";

const entry = (over: Partial<WeightEntry> = {}): WeightEntry => ({
  id: "e1",
  weight_kg: 70.2,
  logged_at: "2026-08-20T07:00:00Z",
  source: "manual",
  ...over,
});

describe("the catalogue", () => {
  it("covers every measured column and nothing derived", () => {
    expect(COMPOSITION_METRICS.map((m) => m.key)).toEqual([
      "weight_kg",
      "body_fat_pct",
      "subcutaneous_fat_pct",
      "visceral_fat_rating",
      "skeletal_muscle_pct",
      "muscle_mass_kg",
      "body_water_pct",
      "protein_pct",
      "bone_mass_kg",
      "scale_bmr_kcal",
    ]);
  });

  it("makes weight the only required field", () => {
    const required = COMPOSITION_METRICS.filter((m) => m.required).map((m) => m.key);
    expect(required).toEqual(["weight_kg"]);
  });
});

describe("unitLabel", () => {
  it("never gives visceral fat a percent sign, in either system", () => {
    const visceral = compositionMetric("visceral_fat_rating");
    expect(unitLabel(visceral, "metric")).toBe("");
    expect(unitLabel(visceral, "imperial")).toBe("");
  });

  it("follows the units preference for the kg-backed metrics only", () => {
    expect(unitLabel(compositionMetric("muscle_mass_kg"), "imperial")).toBe("lb");
    expect(unitLabel(compositionMetric("muscle_mass_kg"), "metric")).toBe("kg");
    // A percentage is a percentage in Ohio too.
    expect(unitLabel(compositionMetric("body_fat_pct"), "imperial")).toBe("%");
    expect(unitLabel(compositionMetric("scale_bmr_kcal"), "imperial")).toBe("kcal");
  });
});

describe("metricAccessibilityLabel", () => {
  it("speaks the unit rather than leaving the symbol unread", () => {
    expect(metricAccessibilityLabel(compositionMetric("body_fat_pct"), "metric")).toBe("Body fat percent");
    expect(metricAccessibilityLabel(compositionMetric("bone_mass_kg"), "imperial")).toBe("Bone mass in pounds");
    expect(metricAccessibilityLabel(compositionMetric("scale_bmr_kcal"), "metric")).toBe(
      "Scale BMR in kilocalories",
    );
  });

  it("says rating for visceral fat, so it is not heard as a percentage", () => {
    const spoken = metricAccessibilityLabel(compositionMetric("visceral_fat_rating"), "metric");
    expect(spoken).toBe("Visceral fat rating");
    expect(spoken).not.toMatch(/percent/i);
  });
});

describe("metricValue", () => {
  it("returns undefined for a metric that was never measured", () => {
    expect(metricValue(entry(), "body_fat_pct")).toBeUndefined();
  });

  it("keeps a measured zero as zero rather than folding it into absent", () => {
    expect(metricValue(entry({ body_fat_pct: 0 }), "body_fat_pct")).toBe(0);
  });

  it("reads the weight column too, so the trend picker needs no special case", () => {
    expect(metricValue(entry(), "weight_kg")).toBe(70.2);
  });
});

describe("sources", () => {
  it("offers only instruments a person could be typing from", () => {
    expect(MANUAL_SOURCES).toEqual(["manual", "inbody", "dexa"]);
    // #314 sets this itself; it is never a manual claim.
    expect(MANUAL_SOURCES).not.toContain("scale_screenshot");
    expect(MANUAL_SOURCES).not.toContain("healthkit");
  });

  it("labels every source, including the ones only other issues write", () => {
    expect(sourceLabel("manual")).toBe("Scale");
    expect(sourceLabel("dexa")).toBe("DEXA");
    expect(sourceLabel("scale_screenshot")).toBe("Scale screenshot");
    expect(sourceLabel("healthkit")).toBe("Apple Health");
  });
});

describe("displayNumber / formatMetricNumber", () => {
  it("converts only the kg-backed metrics for display", () => {
    expect(displayNumber(compositionMetric("muscle_mass_kg"), 50, "imperial")).toBeCloseTo(110.23, 2);
    expect(displayNumber(compositionMetric("body_fat_pct"), 24.2, "imperial")).toBe(24.2);
  });

  it("writes a tenth for a scale's tenths, including Omron's 7.5 visceral rating", () => {
    expect(formatMetricNumber(compositionMetric("visceral_fat_rating"), 7.5)).toBe("7.5");
    expect(formatMetricNumber(compositionMetric("body_fat_pct"), 24.25)).toBe("24.3");
  });

  it("writes BMR whole, because no scale claims a tenth of a kilocalorie", () => {
    expect(formatMetricNumber(compositionMetric("scale_bmr_kcal"), 1620.4)).toBe("1620");
  });
});
