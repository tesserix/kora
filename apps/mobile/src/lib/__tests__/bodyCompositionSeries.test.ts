import type { WeightEntry } from "@/api/types";
import {
  chartableMetrics,
  hasInstrumentChange,
  lastComparableRun,
  metricSeries,
} from "../bodyCompositionSeries";

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
    // And an instrument switch breaks a tape line just like a scale one.
    expect(series.breaksAfter).toEqual([0]);
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
