import { deriveGoalWeightKg, GOAL_WEIGHT_OFFSET_KG } from "@/lib/goalWeightDefault";
import { validateGoalWeight } from "@/lib/validateOnboarding";
import { kgFromLb } from "@/units";

const MIN = 30;
const MAX = 200;

// The imperial weight ruler runs 80-400 lb, which is NOT the metric ruler's
// 30-200 kg — so an imperial screen has to clamp against its own range,
// converted to kilograms, and those bounds are fractional. Snapping after the
// clamp would round the result back past the bound it was just pinned to,
// putting a losing destination a hair ABOVE current weight at the very bottom
// of the scale: a contradiction validateGoalWeight rejects.
describe("deriveGoalWeightKg against fractional (imperial) bounds", () => {
  const min = kgFromLb(80);
  const max = kgFromLb(400);

  it("pins to the fractional bound exactly rather than rounding past it", () => {
    expect(deriveGoalWeightKg("fat_loss", min, min, max)).toBe(min);
    expect(deriveGoalWeightKg("muscle_gain", max, min, max)).toBe(max);
  });

  it("stays acceptable to validateGoalWeight at both ends", () => {
    expect(validateGoalWeight("fat_loss", min, deriveGoalWeightKg("fat_loss", min, min, max))).toBeNull();
    expect(
      validateGoalWeight("muscle_gain", max, deriveGoalWeightKg("muscle_gain", max, min, max)),
    ).toBeNull();
  });
});

describe("deriveGoalWeightKg", () => {
  it("points below current weight while losing", () => {
    expect(deriveGoalWeightKg("fat_loss", 70, MIN, MAX)).toBe(70 - GOAL_WEIGHT_OFFSET_KG);
  });

  it("points above current weight while building", () => {
    expect(deriveGoalWeightKg("muscle_gain", 70, MIN, MAX)).toBe(70 + GOAL_WEIGHT_OFFSET_KG);
  });

  // Maintenance has no destination; the value is never sent or shown, but the
  // function still has to return something inside the ruler's range rather
  // than NaN or a number off the end of the scale.
  it("stays inside the range while maintaining", () => {
    const v = deriveGoalWeightKg("maintenance", 70, MIN, MAX);
    expect(v).toBeGreaterThanOrEqual(MIN);
    expect(v).toBeLessThanOrEqual(MAX);
  });

  it("clamps to the ruler's own range at the extremes", () => {
    expect(deriveGoalWeightKg("fat_loss", MIN, MIN, MAX)).toBe(MIN);
    expect(deriveGoalWeightKg("muscle_gain", MAX, MIN, MAX)).toBe(MAX);
  });

  // The metric ruler steps in 0.5kg, and an imperial current weight converts
  // to an arbitrary number of kilograms — so the derived destination is
  // snapped, or the readout shows 64.853200000000004 kg.
  it("snaps to the ruler's half-kilogram step", () => {
    expect(deriveGoalWeightKg("fat_loss", 69.8532, MIN, MAX)).toBe(65);
    expect(deriveGoalWeightKg("fat_loss", 70.3, MIN, MAX)).toBe(65.5);
  });

  // The whole point: whatever current weight and goal the user lands on, the
  // derived destination must never be the contradiction the screen would then
  // refuse to submit. Clamping at the extremes collapses it onto current
  // weight, which validateGoalWeight accepts (it rejects only strict
  // inequality the wrong way).
  it.each([
    ["fat_loss" as const],
    ["muscle_gain" as const],
  ])("never derives a %s destination that validateGoalWeight rejects", (goal) => {
    for (let weightKg = MIN; weightKg <= MAX; weightKg += 0.5) {
      const goalWeightKg = deriveGoalWeightKg(goal, weightKg, MIN, MAX);
      expect(validateGoalWeight(goal, weightKg, goalWeightKg)).toBeNull();
    }
  });
});
