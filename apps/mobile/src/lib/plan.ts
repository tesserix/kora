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
  /** Reference weight for fat-loss protein; current weight is used when unset. */
  goalWeightKg?: number;
  /** Replaces the computed calories / protein; null or undefined means no override. */
  kcalOverride?: number | null;
  proteinOverrideG?: number | null;
};

/** Mirrors the override error codes in calc.go; the Plan page maps each to copy. */
export type OverrideCode =
  | "kcal_below_resting_burn"
  | "kcal_above_ceiling"
  | "protein_below_min"
  | "protein_above_max"
  | "protein_exceeds_share";

export type Plan = {
  bmr: number;
  tdee: number;
  adjustment: number;
  kcal: number;
  proteinG: number;
  proteinGPerKg: number;
  /** The weight proteinG was computed against (goal weight for fat loss, else current). */
  proteinRefKg: number;
  carbsG: number;
  fatG: number;
  /** True when the BMR floor bound — the target stopped obeying the user. */
  floored: boolean;
  kcalOverridden: boolean;
  proteinOverridden: boolean;
  /** Set when an override was out of bounds; the numbers are then the un-overridden plan. */
  overrideError: OverrideCode | null;
};

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// g/kg of the reference weight, by goal then activity level (mirrors calc.go).
const PROTEIN_FACTORS: Record<PlanGoal, Record<ActivityLevel, number>> = {
  fat_loss: { sedentary: 1.6, light: 1.6, moderate: 1.8, active: 1.8, very_active: 1.8 },
  maintenance: { sedentary: 1.2, light: 1.4, moderate: 1.6, active: 1.6, very_active: 1.6 },
  muscle_gain: { sedentary: 1.8, light: 1.8, moderate: 2.0, active: 2.0, very_active: 2.0 },
};

export function proteinFactor(goal: PlanGoal, activity: ActivityLevel): number {
  return PROTEIN_FACTORS[goal][activity];
}

export const PACE_OPTIONS = [0.25, 0.5, 0.75, 1] as const;

const KCAL_PER_KG = 7700;
const DAYS_PER_WEEK = 7;
const MAX_PACE_FRACTION_OF_BODYWEIGHT = 0.01;
const FAT_CALORIE_PCT = 0.25;
const KCAL_PER_GRAM_FAT = 9;
const KCAL_PER_GRAM_MACRO = 4;
const MAX_KCAL_OVERRIDE_TDEE_MULTIPLE = 2;
const MIN_PROTEIN_OVERRIDE_G_PER_KG = 0.8;
const MAX_PROTEIN_OVERRIDE_G_PER_KG = 2.5;
const MAX_PROTEIN_OVERRIDE_KCAL_SHARE = 0.75;
// Keeps a value exactly on its bound (0.8 x 73 is 58.400000000000006) accepted.
const OVERRIDE_EPSILON = 1e-9;

// Check order matches calc.go: kcal bounds, protein min/max, then share.
// Non-finite values (a blank field parsed to NaN) fail the first bound of
// their kind, as in calc.go.
function kcalError(k: number, bmr: number, tdee: number): OverrideCode | null {
  if (!Number.isFinite(k) || k < bmr - OVERRIDE_EPSILON) return "kcal_below_resting_burn";
  if (k > tdee * MAX_KCAL_OVERRIDE_TDEE_MULTIPLE + OVERRIDE_EPSILON) return "kcal_above_ceiling";
  return null;
}

function proteinError(p: number, weightKg: number, effectiveKcal: number): OverrideCode | null {
  if (!Number.isFinite(p) || p < MIN_PROTEIN_OVERRIDE_G_PER_KG * weightKg - OVERRIDE_EPSILON) {
    return "protein_below_min";
  }
  if (p > MAX_PROTEIN_OVERRIDE_G_PER_KG * weightKg + OVERRIDE_EPSILON) return "protein_above_max";
  if (p * KCAL_PER_GRAM_MACRO > MAX_PROTEIN_OVERRIDE_KCAL_SHARE * effectiveKcal + OVERRIDE_EPSILON) {
    return "protein_exceeds_share";
  }
  return null;
}

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
  let kcal = Math.max(bmr, raw);
  let floored = kcal > raw;

  const proteinRefKg =
    input.goal === "fat_loss" && input.goalWeightKg && input.goalWeightKg > 0
      ? input.goalWeightKg
      : input.weightKg;
  const proteinGPerKg = proteinFactor(input.goal, input.activityLevel);
  let proteinG = proteinGPerKg * proteinRefKg;

  // A bad override is reported, not thrown, and only the failing one is
  // dropped: a valid override is never lost because the other was bad. A
  // surviving protein override is re-checked against the kcal actually used.
  const kcalErr = input.kcalOverride != null ? kcalError(input.kcalOverride, bmr, tdee) : null;
  const kcalOverridden = input.kcalOverride != null && !kcalErr;
  if (kcalOverridden) {
    kcal = input.kcalOverride as number;
    floored = false;
  }
  const proteinErr =
    input.proteinOverrideG != null ? proteinError(input.proteinOverrideG, input.weightKg, kcal) : null;
  const proteinOverridden = input.proteinOverrideG != null && !proteinErr;
  if (proteinOverridden) proteinG = input.proteinOverrideG as number;
  const error = proteinErr ?? kcalErr;

  const fatG = (kcal * FAT_CALORIE_PCT) / KCAL_PER_GRAM_FAT;
  const carbsG = Math.max(
    0,
    (kcal - proteinG * KCAL_PER_GRAM_MACRO - fatG * KCAL_PER_GRAM_FAT) / KCAL_PER_GRAM_MACRO,
  );

  return {
    bmr, tdee, adjustment, kcal, proteinG, proteinGPerKg, proteinRefKg, carbsG, fatG, floored,
    kcalOverridden, proteinOverridden, overrideError: error,
  };
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
