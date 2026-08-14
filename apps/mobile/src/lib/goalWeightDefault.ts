import type { PlanGoal } from "./plan";

/**
 * How far the auto-derived destination sits from current weight. Small enough
 * to read as a starting suggestion the user is expected to adjust, large
 * enough that the plan it produces is a real deficit/surplus rather than noise
 * against the pace stops.
 */
export const GOAL_WEIGHT_OFFSET_KG = 5;

/** The metric destination ruler's own step, so a derived value lands on a stop. */
const STEP_KG = 0.5;

/**
 * The destination to show while the user has not set one themselves.
 *
 * A fixed default cannot work: the screen's goal and current weight both move,
 * and a destination that contradicts them (65kg while building from 70kg, or
 * 65kg while losing from 60kg) is rejected by `validateGoalWeight` — which,
 * now that an untouched destination is validated and submitted like any other,
 * would turn a first tap of the accept button into an error about a number the
 * user never chose. Deriving it from the two values it must agree with keeps
 * that impossible by construction.
 *
 * ALWAYS METRIC, like every other stored measurement on this screen; imperial
 * is a display concern handled by the caller.
 *
 * Clamping is what makes the extremes safe: at the bottom of the range a
 * losing destination collapses onto current weight, at the top a building one
 * does the same, and `validateGoalWeight` accepts equality — it rejects only a
 * destination pointing the wrong way.
 */
export function deriveGoalWeightKg(
  goal: PlanGoal,
  weightKg: number,
  minKg: number,
  maxKg: number,
): number {
  // Maintenance has no destination — the screen hides the ruler and omits the
  // value from the payload — but the function still has to return something on
  // the scale, since the goal can flip back at any time.
  const offset =
    goal === "muscle_gain" ? GOAL_WEIGHT_OFFSET_KG : goal === "fat_loss" ? -GOAL_WEIGHT_OFFSET_KG : 0;
  // Snap FIRST, clamp LAST. The bounds are fractional when they come from the
  // imperial ruler converted to kilograms, and rounding after the clamp would
  // round the result back past the bound it was just pinned to — putting a
  // losing destination a hair above current weight at the bottom of the scale,
  // which is exactly the contradiction this function exists to prevent.
  const snapped = Number((Math.round((weightKg + offset) / STEP_KG) * STEP_KG).toFixed(1));
  return Math.min(maxKg, Math.max(minKg, snapped));
}
