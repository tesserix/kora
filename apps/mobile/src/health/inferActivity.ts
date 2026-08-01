import type { OnboardingInput } from "@/api/types";

export type ActivityInferenceInput = {
  /** Per-day step totals over the observation window. */
  dailySteps: number[];
  /** Mean workout sessions per week across the window. */
  workoutsPerWeek: number;
  /** How many days the window actually covers. */
  daysObserved: number;
};

export type ActivityInference = {
  level: OnboardingInput["activity_level"];
  /** Mean daily steps the level was derived from. */
  meanSteps: number;
  workoutsPerWeek: number;
  /** Human-readable summary of the evidence, shown to the user. */
  reason: string;
};

// Ordered so a training-load bump is an index shift.
const LEVELS: OnboardingInput["activity_level"][] = [
  "sedentary",
  "light",
  "moderate",
  "active",
  "very_active",
];

// Standard NEAT step bands. Lower bound of each level, ascending.
const STEP_BANDS: { min: number; index: number }[] = [
  { min: 12500, index: 4 },
  { min: 10000, index: 3 },
  { min: 7500, index: 2 },
  { min: 5000, index: 1 },
  { min: 0, index: 0 },
];

const MIN_DAYS_OBSERVED = 7;

/**
 * Maps observed Health data to an activity level for the Mifflin–St Jeor
 * multiplier in api/internal/onboarding/calc.go.
 *
 * Returns `null` when there is not enough evidence — fewer than 7 observed days,
 * no step samples, or only zero-step days. That case must fall back to manual
 * selection, NEVER to a level: this repo has already spent a PR undoing three
 * signals that treated absent data as evidence (fastingStreak, recentDeficitPct,
 * AvgIntakeKcal), and a "sedentary" floor would repeat the mistake in the
 * direction that lowers the calorie target — the worst direction for an app that
 * ships eating-disorder guardrails.
 *
 * Steps set the base level; training load lifts it (+1 at >=3 sessions/week, +2
 * at >=5), capped at very_active. Without the workout term a lifter at 3,000
 * steps and five sessions a week reads as sedentary, which is precisely wrong
 * for the "Build muscle" cohort.
 */
export function inferActivityLevel(input: ActivityInferenceInput): ActivityInference | null {
  if (input.daysObserved < MIN_DAYS_OBSERVED) return null;

  const usable = input.dailySteps.filter((n) => Number.isFinite(n) && n >= 0);
  if (usable.length === 0) return null;

  const meanSteps = Math.round(usable.reduce((sum, n) => sum + n, 0) / usable.length);
  // All-zero days are a phone on a desk, not a sedentary life.
  if (meanSteps <= 0) return null;

  const base = STEP_BANDS.find((band) => meanSteps >= band.min)?.index ?? 0;
  const workouts = Number.isFinite(input.workoutsPerWeek) ? Math.max(0, input.workoutsPerWeek) : 0;
  const bump = workouts >= 5 ? 2 : workouts >= 3 ? 1 : 0;
  const level = LEVELS[Math.min(base + bump, LEVELS.length - 1)];

  const stepsText = meanSteps.toLocaleString("en-US");
  const workoutText =
    workouts >= 1
      ? `, and about ${Math.round(workouts)} workout${Math.round(workouts) === 1 ? "" : "s"} a week`
      : "";

  return {
    level,
    meanSteps,
    workoutsPerWeek: workouts,
    reason: `About ${stepsText} steps a day${workoutText} over the last ${input.daysObserved} days.`,
  };
}
