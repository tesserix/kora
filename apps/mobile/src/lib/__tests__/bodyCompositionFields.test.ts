import type { BodyCompositionReading, WeightEntry } from "@/api/types";
import {
  COMPOSITION_METRICS,
  DETECTABLE_SOURCES,
  MANUAL_SOURCES,
  compositionMetric,
  detectedInstrumentSource,
  displayNumber,
  formatMetricNumber,
  metricAccessibilityLabel,
  isConvertedMetric,
  metricValue,
  orderSourcesDetectedFirst,
  storedNumber,
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
      // kora#45's tape measurements, appended AFTER the scale metrics. See
      // the ordering comment on COMPOSITION_METRICS: the list above is a
      // Renpho screenshot read top to bottom, and a tape measurement is not
      // on that screenshot.
      "neck_cm",
      "chest_cm",
      "waist_cm",
      "hip_cm",
      "arm_cm",
      "thigh_cm",
    ]);
  });

  it("keeps weight first, because BodyCompositionForm destructures it off the front", () => {
    // `const [WEIGHT_METRIC, ...OTHER_METRICS] = COMPOSITION_METRICS` — if
    // weight stops being index 0 the weigh-in sheet silently renders some
    // other metric as its always-visible field.
    expect(COMPOSITION_METRICS[0].key).toBe("weight_kg");
  });

  it("puts every tape measurement in the tail, so all six land inside More fields", () => {
    // The same destructure sends everything after index 0 into the
    // disclosure. Being LAST is additionally what keeps the six off the
    // first screen of the two-tap weigh-in; a tape metric slotted in beside
    // body fat would still be in OTHER_METRICS but would push the scale
    // metrics down for no reason.
    const keys = COMPOSITION_METRICS.map((m) => m.key);
    const lengthKeys = COMPOSITION_METRICS.filter((m) => m.unitKind === "length").map((m) => m.key);
    expect(lengthKeys).toHaveLength(6);
    expect(keys.slice(-6)).toEqual(lengthKeys);
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

  it("labels a tape measurement cm or in, never kg or lb (kora#45)", () => {
    const waist = compositionMetric("waist_cm");
    expect(unitLabel(waist, "metric")).toBe("cm");
    expect(unitLabel(waist, "imperial")).toBe("in");
    // A length sharing the mass unit is the specific mistake `length`
    // exists to make impossible.
    expect(unitLabel(waist, "imperial")).not.toBe("lb");
  });

  it("gives all six tape measurements the same unit, not just the one that was tested", () => {
    const lengths = COMPOSITION_METRICS.filter((m) => m.unitKind === "length");
    expect(lengths.map((m) => unitLabel(m, "metric"))).toEqual(["cm", "cm", "cm", "cm", "cm", "cm"]);
    expect(lengths.map((m) => unitLabel(m, "imperial"))).toEqual(["in", "in", "in", "in", "in", "in"]);
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

  it("speaks a tape measurement's unit in words, following the same convention", () => {
    expect(metricAccessibilityLabel(compositionMetric("waist_cm"), "metric")).toBe("Waist in centimetres");
    expect(metricAccessibilityLabel(compositionMetric("waist_cm"), "imperial")).toBe("Waist in inches");
    expect(metricAccessibilityLabel(compositionMetric("hip_cm"), "metric")).toBe("Hip in centimetres");
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

  it("converts a tape measurement cm to in, and only for an imperial reader", () => {
    const waist = compositionMetric("waist_cm");
    // 2.54 cm to the inch: 88.9 cm is exactly 35 in.
    expect(displayNumber(waist, 88.9, "imperial")).toBeCloseTo(35, 6);
    expect(displayNumber(waist, 88.9, "metric")).toBe(88.9);
  });

  it("writes a tenth for a scale's tenths, including Omron's 7.5 visceral rating", () => {
    expect(formatMetricNumber(compositionMetric("visceral_fat_rating"), 7.5)).toBe("7.5");
    expect(formatMetricNumber(compositionMetric("body_fat_pct"), 24.25)).toBe("24.3");
  });

  it("writes BMR whole, because no scale claims a tenth of a kilocalorie", () => {
    expect(formatMetricNumber(compositionMetric("scale_bmr_kcal"), 1620.4)).toBe("1620");
  });
});

// kora#314 PR C: a sibling PR is adding a nullable `instrument` field to
// the read response, and this branch is built against api/ before that PR
// necessarily lands. These tests construct readings with the field present
// via an unknown-cast (BodyCompositionReading does not declare it yet on
// this branch), exercising `detectedInstrumentSource` exactly the way it
// reads the wire response: defensively, through an untyped index.
describe("detectedInstrumentSource", () => {
  const reading = (over: Record<string, unknown> = {}): BodyCompositionReading =>
    ({ weight_kg: 70, ...over }) as unknown as BodyCompositionReading;

  it("falls back to scale_screenshot when the field is entirely absent (API hasn't shipped detection yet)", () => {
    expect(detectedInstrumentSource(reading())).toBe("scale_screenshot");
  });

  it("falls back to scale_screenshot when the field is present but null", () => {
    expect(detectedInstrumentSource(reading({ instrument: null }))).toBe("scale_screenshot");
  });

  it("falls back to scale_screenshot for a value outside the three it's allowed to be", () => {
    expect(detectedInstrumentSource(reading({ instrument: "some_future_instrument" }))).toBe(
      "scale_screenshot",
    );
    // Not even every OTHER real WeightSource — "manual" and "healthkit" are
    // never something a screenshot detects.
    expect(detectedInstrumentSource(reading({ instrument: "manual" }))).toBe("scale_screenshot");
  });

  it("trusts each of the three values detection is allowed to produce", () => {
    expect(detectedInstrumentSource(reading({ instrument: "scale_screenshot" }))).toBe("scale_screenshot");
    expect(detectedInstrumentSource(reading({ instrument: "inbody" }))).toBe("inbody");
    expect(detectedInstrumentSource(reading({ instrument: "dexa" }))).toBe("dexa");
  });
});

describe("orderSourcesDetectedFirst", () => {
  it("puts the detected instrument first and keeps the other two, with none dropped or duplicated", () => {
    expect(orderSourcesDetectedFirst("dexa")).toEqual(["dexa", "scale_screenshot", "inbody"]);
    expect(orderSourcesDetectedFirst("inbody")).toEqual(["inbody", "scale_screenshot", "dexa"]);
    expect(orderSourcesDetectedFirst("scale_screenshot")).toEqual(DETECTABLE_SOURCES);
  });
});

describe("storedNumber", () => {
  it("is the exact inverse of displayNumber for every converted metric", () => {
    // The failure this guards is subtle and silent: if these two directions
    // ever disagree, a typed 35 in round-trips into a 35 cm column and
    // nothing on screen looks wrong.
    for (const metric of COMPOSITION_METRICS) {
      for (const system of ["metric", "imperial"] as const) {
        const stored = 33.3;
        expect(storedNumber(metric, displayNumber(metric, stored, system), system)).toBeCloseTo(stored, 6);
      }
    }
  });

  it("reads an imperial tape entry as inches, so cm is what actually gets stored", () => {
    expect(storedNumber(compositionMetric("waist_cm"), 35, "imperial")).toBeCloseTo(88.9, 6);
    // Metric types cm directly; nothing to convert.
    expect(storedNumber(compositionMetric("waist_cm"), 88.9, "metric")).toBe(88.9);
  });

  it("leaves a percentage, a rating and a kcal figure alone in either system", () => {
    expect(storedNumber(compositionMetric("body_fat_pct"), 22.2, "imperial")).toBe(22.2);
    expect(storedNumber(compositionMetric("visceral_fat_rating"), 7.5, "imperial")).toBe(7.5);
    expect(storedNumber(compositionMetric("scale_bmr_kcal"), 1620, "imperial")).toBe(1620);
  });
});

describe("isConvertedMetric", () => {
  it("covers length as well as mass — the reason it replaced isMassMetric at the conversion sites", () => {
    expect(isConvertedMetric(compositionMetric("weight_kg"))).toBe(true);
    expect(isConvertedMetric(compositionMetric("waist_cm"))).toBe(true);
    expect(isConvertedMetric(compositionMetric("body_fat_pct"))).toBe(false);
    expect(isConvertedMetric(compositionMetric("visceral_fat_rating"))).toBe(false);
    expect(isConvertedMetric(compositionMetric("scale_bmr_kcal"))).toBe(false);
  });
});

describe("the tape measurements' own bounds", () => {
  it("mirrors validateComposition's 0-exclusive to 300cm, in centimetres", () => {
    // Stated in STORED units because that is what the form range-checks
    // against, after converting whatever the user typed. Mirrors
    // maxMeasurementCm in api/internal/tracking/repository.go — a form that
    // accepted more than the server does would turn a typo into a save
    // failure with no field to point at.
    for (const metric of COMPOSITION_METRICS.filter((m) => m.unitKind === "length")) {
      expect(metric.range).toEqual({ min: 0, max: 300, exclusiveMin: true });
    }
  });

  it("leaves every tape measurement optional — weight stays the only required field", () => {
    for (const metric of COMPOSITION_METRICS.filter((m) => m.unitKind === "length")) {
      expect(metric.required).toBeUndefined();
    }
  });
});
