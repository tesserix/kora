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

/**
 * Why there is no rate, when — and only when — saying so is safe (kora#405).
 *
 * `insufficient_data` and `suppressed` both render as nothing today, which is
 * indistinguishable from a bug. That cost a real investigation: a user with 18
 * weigh-ins saw a blank space and reasonably concluded the feature was broken.
 *
 * So this explains the gate, and stays SILENT for `suppressed`.
 *
 * The silence is deliberate and load-bearing, not an oversight. `suppressed`
 * means the #23 Protective policy classified this user as at eating-disorder
 * risk. Telling them "we've hidden your weight trend because of your intake"
 * discloses an inference about them that the policy exists to act on quietly.
 * A blank space is a worse debugging experience and a better outcome for the
 * person it is protecting.
 *
 * If you are tempted to return a message for `suppressed` too: that is the
 * change this comment exists to stop. There is a test on it.
 */
export function trendUnavailableNote(trend: WeightTrend): string | null {
  if (trend.status !== "insufficient_data") return null;
  return "Not enough weigh-ins yet — a weekly rate needs 4, spread over at least 14 days.";
}
