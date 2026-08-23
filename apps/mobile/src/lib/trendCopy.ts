import type { WeightTrend } from "@/api/types";
import type { UnitSystem } from "@/units";
import { displayNumber, unitLabel, type CompositionMetric } from "./bodyCompositionFields";

/**
 * The one place a rate becomes a sentence (kora#45, framed per kora#23).
 *
 * Past tense, and it names its own basis. It states what HAS happened over a
 * measured window and makes no claim about what will happen — no future
 * tense, no date, no goal, no "on track". Those are what turn an estimate
 * into a promise, and there is a test asserting each of them is absent.
 *
 * Returns null for anything but a fitted rate. A suppressed trend carries no
 * number at all, so there is nothing here to leak.
 */
export function trendSentence(
  trend: WeightTrend,
  metric: CompositionMetric,
  system: UnitSystem,
): string | null {
  if (trend.status !== "ok" || trend.rate_per_week === undefined || !trend.basis) return null;

  const converted = displayNumber(metric, trend.rate_per_week, system);
  const magnitude = Math.abs(converted).toFixed(1);
  const unit = unitLabel(metric, system);
  const direction = converted > 0 ? " up" : converted < 0 ? " down" : "";
  const { readings, days } = trend.basis;

  return `About ${magnitude}${unit ? ` ${unit}` : ""} per week${direction} — based on ${readings} readings over the last ${days} days.`;
}
