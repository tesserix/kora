import type { WeightEntry } from "@/api/types";
import {
  chartableMetrics,
  comparableRunFor,
  fitsAcrossInstruments,
  hasInstrumentChange,
  lastComparableRun,
  instrumentChangeNote,
  metricSeries,
} from "../bodyCompositionSeries";
import { COMPOSITION_METRICS } from "../bodyCompositionFields";

const metricFor = (key: string) => COMPOSITION_METRICS.find((m) => m.key === key)!;

let n = 0;
const entry = (over: Partial<WeightEntry> = {}): WeightEntry => ({
  id: `e${++n}`,
  weight_kg: 70,
  logged_at: `2026-08-${String(10 + n).padStart(2, "0")}T07:00:00Z`,
  source: "manual",
  ...over,
});

beforeEach(() => {
  n = 0;
});

describe("metricSeries", () => {
  it("drops a day with no reading rather than plotting it as zero", () => {
    const series = metricSeries(
      [entry({ body_fat_pct: 24.2 }), entry(), entry({ body_fat_pct: 23.8 })],
      "body_fat_pct",
    );
    expect(series.points.map((p) => p.value)).toEqual([24.2, 23.8]);
  });

  it("plots a measured zero, because absent and zero are different facts", () => {
    const series = metricSeries([entry({ body_fat_pct: 0 }), entry({ body_fat_pct: 3 })], "body_fat_pct");
    expect(series.points.map((p) => p.value)).toEqual([0, 3]);
  });

  it("carries each point's own date, so the axis labels the metric's range not the weigh-ins'", () => {
    const series = metricSeries([entry(), entry({ body_fat_pct: 24.2 })], "body_fat_pct");
    expect(series.points[0].loggedAt).toBe("2026-08-12T07:00:00Z");
  });

  it("charts weight through the same path, with no special case", () => {
    expect(metricSeries([entry({ weight_kg: 70.2 }), entry({ weight_kg: 69.8 })], "weight_kg").points).toHaveLength(
      2,
    );
  });
});

describe("instrument changes", () => {
  it("reports no break for a single-instrument history", () => {
    const series = metricSeries(
      [entry({ skeletal_muscle_pct: 48.9 }), entry({ skeletal_muscle_pct: 49.1 })],
      "skeletal_muscle_pct",
    );
    expect(series.breaksAfter).toEqual([]);
    expect(hasInstrumentChange(series)).toBe(false);
    expect(series.sources).toEqual(["manual"]);
  });

  it("breaks the line where the instrument changes, at the last comparable point", () => {
    // The Renpho-to-DEXA cliff: 48.9 to 25.7 is a definition change, not a loss.
    const series = metricSeries(
      [
        entry({ skeletal_muscle_pct: 48.9, source: "manual" }),
        entry({ skeletal_muscle_pct: 49.1, source: "manual" }),
        entry({ skeletal_muscle_pct: 25.7, source: "dexa" }),
      ],
      "skeletal_muscle_pct",
    );
    expect(series.breaksAfter).toEqual([1]);
    expect(hasInstrumentChange(series)).toBe(true);
    expect(series.sources).toEqual(["manual", "dexa"]);
  });

  it("counts the break in the METRIC's own indices, not the entry list's", () => {
    // A weight-only day sits between the two composition readings; it must not
    // shift where the break is drawn.
    const series = metricSeries(
      [
        entry({ body_fat_pct: 24.2, source: "manual" }),
        entry({ source: "manual" }),
        entry({ body_fat_pct: 19.4, source: "dexa" }),
      ],
      "body_fat_pct",
    );
    expect(series.points).toHaveLength(2);
    expect(series.breaksAfter).toEqual([0]);
  });

  it("breaks again when the instrument changes back", () => {
    const series = metricSeries(
      [
        entry({ body_fat_pct: 24.2, source: "manual" }),
        entry({ body_fat_pct: 19.4, source: "dexa" }),
        entry({ body_fat_pct: 24.0, source: "manual" }),
      ],
      "body_fat_pct",
    );
    expect(series.breaksAfter).toEqual([0, 1]);
    // Seen twice, listed once, in first-appearance order.
    expect(series.sources).toEqual(["manual", "dexa"]);
  });
});

describe("chartableMetrics", () => {
  it("offers only metrics this history actually holds", () => {
    const metrics = chartableMetrics([entry({ body_fat_pct: 24.2 }), entry({ visceral_fat_rating: 7 })]);
    expect(metrics.map((m) => m.key)).toEqual(["weight_kg", "body_fat_pct", "visceral_fat_rating"]);
  });

  it("offers weight alone for a weight-only history, so no picker is shown", () => {
    expect(chartableMetrics([entry(), entry()]).map((m) => m.key)).toEqual(["weight_kg"]);
  });

  it("offers nothing at all for an empty history", () => {
    expect(chartableMetrics([])).toEqual([]);
  });

  // kora#45's tape measurements need no work here — the picker derives its
  // chips from COMPOSITION_METRICS — but "needs no work" is exactly the claim
  // worth pinning, since it is what would break silently if the catalogue
  // ever grew a metric the chart could not read.
  it("offers a tape measurement as a chip once one has been recorded", () => {
    const metrics = chartableMetrics([entry({ waist_cm: 88.8 }), entry({ thigh_cm: 44.4 })]);
    expect(metrics.map((m) => m.key)).toEqual(["weight_kg", "waist_cm", "thigh_cm"]);
  });

  it("offers no chip for a tape measurement that was never recorded", () => {
    // The behaviour that keeps six always-empty chips off a screen where most
    // people only ever log weight.
    const keys = chartableMetrics([entry({ waist_cm: 88.8 })]).map((m) => m.key);
    expect(keys).not.toContain("neck_cm");
    expect(keys).not.toContain("hip_cm");
    expect(keys).toEqual(["weight_kg", "waist_cm"]);
  });
});

describe("a tape measurement with no readings", () => {
  it("is an empty series rather than a throw or a zero point", () => {
    // progress.tsx charts `metricSeries(entries, activeKey)` and falls back to
    // weight when the selected metric is not in `chartableMetrics`; this is
    // the behaviour that fallback rests on.
    const series = metricSeries([entry(), entry()], "neck_cm");
    expect(series.points).toEqual([]);
    expect(series.breaksAfter).toEqual([]);
    expect(series.sources).toEqual([]);
    expect(lastComparableRun(series)).toEqual([]);
    expect(hasInstrumentChange(series)).toBe(false);
  });

  it("plots a tape measurement the same way as any other metric once it has readings", () => {
    const series = metricSeries(
      [entry({ waist_cm: 88.8 }), entry(), entry({ waist_cm: 87.7, source: "dexa" })],
      "waist_cm",
    );
    // The weight-only day in the middle is dropped, not plotted as 0cm.
    expect(series.points.map((p) => p.value)).toEqual([88.8, 87.7]);
    // An instrument switch does NOT break a tape line (kora#419). This
    // asserted the opposite until the #397 rule reached the chart: `source`
    // records the instrument that produced the WEIGH-IN, so breaking a tape
    // series on it splits on something unrelated to how the tape was read.
    expect(series.breaksAfter).toEqual([]);
  });
});

describe("lastComparableRun", () => {
  it("is the whole series when one instrument measured all of it", () => {
    const series = metricSeries([entry({ body_fat_pct: 24.2 }), entry({ body_fat_pct: 23.8 })], "body_fat_pct");
    expect(lastComparableRun(series).map((p) => p.value)).toEqual([24.2, 23.8]);
  });

  it("is only the readings since the instrument changed", () => {
    const series = metricSeries(
      [
        entry({ body_fat_pct: 24.2, source: "manual" }),
        entry({ body_fat_pct: 24.0, source: "manual" }),
        entry({ body_fat_pct: 19.4, source: "dexa" }),
        entry({ body_fat_pct: 19.1, source: "dexa" }),
      ],
      "body_fat_pct",
    );
    // A change computed over the whole series would report -5.1 points of fat
    // lost, when 4.6 of that is DEXA and bioimpedance disagreeing.
    expect(lastComparableRun(series).map((p) => p.value)).toEqual([19.4, 19.1]);
  });
});

// kora#397: the delta beneath the chart used lastComparableRun for EVERY
// metric, while the weekly rate beside it fits weight across instruments. On a
// weight history spanning a scale change the two described different windows
// and could disagree in sign — "Up 0.8 kg" above "About 0.4 kg per week down".
describe("comparableRunFor (kora#397)", () => {
  it("spans instruments for weight, matching the rate shown beneath it", () => {
    const series = metricSeries(
      [
        entry({ weight_kg: 80, source: "manual" }),
        entry({ weight_kg: 79, source: "manual" }),
        entry({ weight_kg: 78, source: "healthkit" }),
        entry({ weight_kg: 77, source: "healthkit" }),
      ],
      "weight_kg",
    );
    expect(comparableRunFor(series, metricFor("weight_kg")).map((p) => p.value)).toEqual([80, 79, 78, 77]);
  });

  it("spans instruments for a tape measurement, which the weigh-in's source says nothing about", () => {
    const series = metricSeries(
      [
        entry({ waist_cm: 90, source: "manual" }),
        entry({ waist_cm: 89, source: "manual" }),
        entry({ waist_cm: 88, source: "scale_screenshot" }),
      ],
      "waist_cm",
    );
    expect(comparableRunFor(series, metricFor("waist_cm")).map((p) => p.value)).toEqual([90, 89, 88]);
  });

  it("still truncates a composition percentage, where vendors genuinely disagree", () => {
    const series = metricSeries(
      [
        entry({ body_fat_pct: 24.2, source: "manual" }),
        entry({ body_fat_pct: 24.0, source: "manual" }),
        entry({ body_fat_pct: 19.4, source: "dexa" }),
      ],
      "body_fat_pct",
    );
    expect(comparableRunFor(series, metricFor("body_fat_pct")).map((p) => p.value)).toEqual([19.4]);
  });
});

describe("fitsAcrossInstruments (kora#397)", () => {
  it("is true for weight and every tape measurement, false for everything else", () => {
    const across = COMPOSITION_METRICS.filter(fitsAcrossInstruments).map((m) => m.key);
    expect(across).toEqual([
      "weight_kg",
      "neck_cm",
      "chest_cm",
      "waist_cm",
      "hip_cm",
      "arm_cm",
      "thigh_cm",
    ]);
  });
});

describe("metrics that fit across instruments (#419)", () => {
  // The rule #397 settled for the delta and the rate, applied to the chart:
  // scales disagree about weight by a few hundred grams, so a weight series
  // must NOT be split by instrument. Splitting it drew "separate lines"
  // under a delta measured straight across those same lines.
  it("draws no break in a weight series that changes instrument", () => {
    const series = metricSeries(
      [
        entry({ weight_kg: 77.0, source: "healthkit" }),
        entry({ weight_kg: 77.2, source: "manual" }),
        entry({ weight_kg: 77.1, source: "scale_screenshot" }),
      ],
      "weight_kg",
    );
    expect(series.breaksAfter).toEqual([]);
  });

  it("draws no break in a tape series that changes instrument", () => {
    // `source` describes the WEIGH-IN, not the tape, so splitting a tape
    // series on it splits on something unrelated to how it was measured.
    const series = metricSeries(
      [entry({ waist_cm: 88.8, source: "manual" }), entry({ waist_cm: 88.2, source: "healthkit" })],
      "waist_cm",
    );
    expect(series.breaksAfter).toEqual([]);
  });

  it("still breaks a composition percentage, which is the case the split exists for", () => {
    const series = metricSeries(
      [
        entry({ body_fat_pct: 24.2, source: "manual" }),
        entry({ body_fat_pct: 19.4, source: "dexa" }),
      ],
      "body_fat_pct",
    );
    expect(series.breaksAfter).toEqual([0]);
  });

  it("reports no instrument change for weight, so the note never contradicts the delta", () => {
    const series = metricSeries(
      [entry({ weight_kg: 77.0, source: "healthkit" }), entry({ weight_kg: 77.2, source: "manual" })],
      "weight_kg",
    );
    expect(hasInstrumentChange(series)).toBe(false);
  });
});

describe("instrumentChangeNote (#419)", () => {
  it("does not say 'the two' when three instruments measured the series", () => {
    const note = instrumentChangeNote(["scale_screenshot", "healthkit", "manual"]);
    expect(note).not.toContain("the two");
    expect(note).toContain("Scale screenshot, then Apple Health, then");
  });

  it("names a typed-in reading as typed, not as a second kind of scale", () => {
    // `manual` is labelled "Scale" in the form's "Measured with" picker,
    // which is right there and wrong here: beside "Scale screenshot" it
    // reads as one device rather than a number a person entered.
    const note = instrumentChangeNote(["scale_screenshot", "manual"]);
    expect(note).toContain("Scale screenshot, then Scale (typed in)");
    // The bare "Scale" that made the two look like one device must be gone,
    // while the word "Scale" itself stays -- a typed reading did come off a
    // scale, and "Measured by typed in" is not a sentence.
    expect(note).not.toMatch(/then Scale\./);
    expect(note).toContain("typed in");
  });

  it("still reads naturally for the two-instrument case", () => {
    expect(instrumentChangeNote(["manual", "dexa"])).toContain("DEXA");
  });
});
