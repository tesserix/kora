import type { WeightEntry, WeightSource } from "@/api/types";
import { isComparable } from "./bodyComposition";
import {
  COMPOSITION_METRICS,
  metricValue,
  type CompositionMetric,
  type CompositionMetricKey,
} from "./bodyCompositionFields";

/**
 * Turning a list of weigh-ins into ONE metric's trend (kora#45).
 *
 * Two rules live here, and both exist because the obvious implementation is
 * wrong in a way that looks right on screen.
 *
 * 1. A weigh-in with no reading for the chosen metric is DROPPED, never
 *    plotted as zero. Someone who logs weight daily and body fat weekly would
 *    otherwise get a body-fat trend that plunges to 0 six days out of seven.
 *
 * 2. Readings from different instruments are not joined. Renpho reports
 *    Skeletal Muscle at 48.9% where Omron reports 25.7% for the same body, and
 *    a single line through both draws a person losing half their muscle
 *    overnight. `isComparable` decides; this module reports WHERE the line must
 *    break, and the chart draws the break.
 */

export interface MetricPoint {
  value: number;
  /** ISO timestamp from the entry, so an axis can label the metric's own range. */
  loggedAt: string;
  source: WeightSource;
}

export interface MetricSeries {
  key: CompositionMetricKey;
  points: MetricPoint[];
  /**
   * Indices into `points` AFTER which the series is not continuous — the last
   * point measured by one instrument before another takes over. Empty for a
   * single-instrument history, which is every history until the day someone
   * buys a new scale.
   */
  breaksAfter: number[];
  /** Distinct instruments, in the order they first appear. */
  sources: WeightSource[];
}

/** The trend for one metric, in the order the entries were given (oldest first). */
export function metricSeries(entries: readonly WeightEntry[], key: CompositionMetricKey): MetricSeries {
  const points: MetricPoint[] = entries.flatMap((entry) => {
    const value = metricValue(entry, key);
    if (value === undefined) return [];
    return [{ value, loggedAt: entry.logged_at, source: entry.source }];
  });

  const breaksAfter = points.flatMap((point, i) =>
    i < points.length - 1 && !isComparable(point.source, points[i + 1].source) ? [i] : [],
  );

  const sources = points.reduce<WeightSource[]>(
    (seen, p) => (seen.includes(p.source) ? seen : [...seen, p.source]),
    [],
  );

  return { key, points, breaksAfter, sources };
}

/**
 * The metrics this history can actually chart.
 *
 * The picker is built from this rather than from the full catalogue, so
 * someone who only ever logs weight sees no picker at all instead of fifteen
 * chips that all lead to an empty chart. Weight is not special-cased — it
 * qualifies the same way, by having values.
 */
export function chartableMetrics(entries: readonly WeightEntry[]): CompositionMetric[] {
  return COMPOSITION_METRICS.filter((metric) =>
    entries.some((entry) => metricValue(entry, metric.key) !== undefined),
  );
}

/** Whether a metric's trend spans instruments, and so cannot be read as one line. */
export function hasInstrumentChange(series: MetricSeries): boolean {
  return series.breaksAfter.length > 0;
}

/**
 * The trailing run of points that share an instrument.
 *
 * A "change over this range" figure computed across an instrument switch is
 * the artefact this whole module exists to prevent — it would report Renpho's
 * 48.9% minus Omron's 25.7% as 23 points of muscle lost. Callers show a change
 * for THIS run only, and say so when there is an earlier one they are not
 * counting.
 */
export function lastComparableRun(series: MetricSeries): MetricPoint[] {
  const lastBreak = series.breaksAfter[series.breaksAfter.length - 1];
  return lastBreak === undefined ? series.points : series.points.slice(lastBreak + 1);
}
