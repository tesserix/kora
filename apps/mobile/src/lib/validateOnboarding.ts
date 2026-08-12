import type { PlanGoal } from "./plan";

// Range-validates the ALWAYS-METRIC height (cm) and weight (kg) values. The
// optional unit labels only affect the error copy shown to the user, so an
// imperial user sees "in ft/in" / "in lb" instead of "in cm" / "in kg" — the
// numbers validated are metric regardless.
//
// The first argument is AGE, not birth year: the screen collects age because a
// ruler of years-old is legible where a ruler of calendar years is not. The
// wire format still sends birth_year, derived at submit.
export function validateOnboardingNumbers(
  age: string,
  heightCm: string,
  weightKg: string,
  opts?: { heightUnit?: string; weightUnit?: string },
): string | null {
  const heightUnit = opts?.heightUnit ?? "cm";
  const weightUnit = opts?.weightUnit ?? "kg";
  const a = Number(age);
  const h = Number(heightCm);
  const w = Number(weightKg);

  if (!age || !heightCm || !weightKg) {
    return "Please fill in your age, height, and weight.";
  }
  if (Number.isNaN(a) || Number.isNaN(h) || Number.isNaN(w)) {
    return "Age, height, and weight must be numbers.";
  }
  if (a < 13 || a > 120) {
    return "Please enter an age between 13 and 120.";
  }
  if (h <= 0 || h > 260) {
    return `Please enter a valid height in ${heightUnit}.`;
  }
  // Same 20kg floor validateGoalWeight applies. Without it a current
  // weight under 20 leaves the goal-weight field unsatisfiable: no value
  // can be both above the plausibility floor and at or below current weight.
  if (w < 20 || w > 500) {
    return `Please enter a valid weight in ${weightUnit}.`;
  }
  return null;
}

// A goal weight pointing the opposite way from the goal is a contradiction the
// user can see on screen, so it is caught in the field rather than by the
// server. Maintenance has no destination and is never checked.
export function validateGoalWeight(
  goal: PlanGoal,
  weightKg: number,
  goalWeightKg: number,
  weightUnit = "kg",
): string | null {
  if (goal === "maintenance") return null;
  if (goalWeightKg <= 20 || goalWeightKg > 500) {
    return `Please enter a valid goal weight in ${weightUnit}.`;
  }
  if (goal === "fat_loss" && goalWeightKg > weightKg) {
    return "Your goal weight is above your current weight. Pick Build muscle instead, or lower the goal.";
  }
  if (goal === "muscle_gain" && goalWeightKg < weightKg) {
    return "Your goal weight is below your current weight. Pick Lose weight instead, or raise the goal.";
  }
  return null;
}
