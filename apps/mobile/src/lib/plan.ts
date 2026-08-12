// TypeScript mirror of api/internal/onboarding/calc.go.
//
// It exists because the onboarding readout recalculates on every drag frame
// and cannot round-trip to the API that often. The server stays authoritative:
// its response on accept overwrites whatever this produced. The two are kept
// honest by api/internal/onboarding/testdata/golden_targets.json, which both
// languages' test suites assert against — change one side alone and the other
// goes red.

export type PlanGoal = "fat_loss" | "maintenance" | "muscle_gain";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export type PlanInput = {
  sex: "male" | "female";
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: PlanGoal;
  paceKgPerWeek: number;
};

export type Plan = {
  bmr: number;
  tdee: number;
  adjustment: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** True when the BMR floor bound — the target stopped obeying the user. */
  floored: boolean;
};

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const PACE_OPTIONS = [0.25, 0.5, 0.75, 1] as const;

const KCAL_PER_KG = 7700;
const DAYS_PER_WEEK = 7;
const MAX_PACE_FRACTION_OF_BODYWEIGHT = 0.01;
const PROTEIN_G_PER_KG = 2.0;
const FAT_CALORIE_PCT = 0.25;
const KCAL_PER_GRAM_FAT = 9;
const KCAL_PER_GRAM_MACRO = 4;

/**
 * Computes energy and macro targets from user metrics.
 *
 * Assumes a pace drawn from `availablePaces`, which ensures the pace does not
 * exceed 1% of bodyweight. An over-cap pace is left to the server to reject
 * rather than being silently clamped here — clamping would hide from the user
 * that their request was refused. A negative pace is clamped to zero instead
 * of inverting the goal (e.g. a drag gesture briefly overshooting zero should
 * produce a maintenance target, not a fat-loss surplus).
 */
export function computePlan(input: PlanInput): Plan {
  // A negative pace is meaningless and, left alone, would flip the sign of
  // the adjustment and hand a fat-loss user a surplus. Go rejects it at the
  // API boundary; here it degrades to "no adjustment" so a mid-drag
  // overshoot can never produce an inverted target.
  const paceKgPerWeek = Math.max(0, input.paceKgPerWeek);

  const sexOffset = input.sex === "male" ? 5 : -161;
  const bmr = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age + sexOffset;
  const tdee = bmr * ACTIVITY_FACTORS[input.activityLevel];

  let adjustment = 0;
  if (input.goal === "fat_loss") {
    adjustment = -(paceKgPerWeek * KCAL_PER_KG) / DAYS_PER_WEEK;
  } else if (input.goal === "muscle_gain") {
    adjustment = (paceKgPerWeek * KCAL_PER_KG) / DAYS_PER_WEEK;
  }

  const raw = tdee + adjustment;
  const kcal = Math.max(bmr, raw);

  const proteinG = PROTEIN_G_PER_KG * input.weightKg;
  const fatG = (kcal * FAT_CALORIE_PCT) / KCAL_PER_GRAM_FAT;
  const carbsG = Math.max(
    0,
    (kcal - proteinG * KCAL_PER_GRAM_MACRO - fatG * KCAL_PER_GRAM_FAT) / KCAL_PER_GRAM_MACRO,
  );

  return { bmr, tdee, adjustment, kcal, proteinG, carbsG, fatG, floored: kcal > raw };
}

/**
 * The pace stops this body is allowed to pick. Deriving the options from
 * bodyweight means the UI can never offer a stop the server would reject —
 * at 84kg the cap is 0.84kg/week, so the 1.0 stop simply is not there.
 * The slowest stop is always offered, even to a body under 25kg, so the
 * control is never empty.
 */
export function availablePaces(weightKg: number): number[] {
  const cap = weightKg * MAX_PACE_FRACTION_OF_BODYWEIGHT;
  const allowed = PACE_OPTIONS.filter((pace) => pace <= cap);
  return allowed.length > 0 ? allowed : [PACE_OPTIONS[0]];
}

/** Whole weeks to cover the distance, rounded up. Zero when already there. */
export function weeksToGoal(weightKg: number, goalWeightKg: number, paceKgPerWeek: number): number {
  const distance = Math.abs(goalWeightKg - weightKg);
  if (distance === 0 || paceKgPerWeek <= 0) return 0;
  return Math.ceil(distance / paceKgPerWeek);
}
