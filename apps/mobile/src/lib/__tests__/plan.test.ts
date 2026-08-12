import { readFileSync } from "fs";
import { join } from "path";
import { availablePaces, computePlan, weeksToGoal, type PlanInput } from "../plan";

type GoldenCase = {
  name: string;
  sex: "male" | "female";
  age: number;
  height_cm: number;
  weight_kg: number;
  activity_level: PlanInput["activityLevel"];
  goal: PlanInput["goal"];
  pace_kg_per_week: number;
  bmr: number;
  tdee: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  floored: boolean;
};

const goldenCases = JSON.parse(
  readFileSync(join(__dirname, "../../../../../api/internal/onboarding/testdata/golden_targets.json"), "utf8"),
) as GoldenCase[];

// The same fixture api/internal/onboarding/calc_test.go asserts. If these two
// implementations ever diverge, one language's suite goes red.
describe("computePlan matches the Go golden vectors", () => {
  it.each(goldenCases)("$name", (c) => {
    const plan = computePlan({
      sex: c.sex,
      age: c.age,
      heightCm: c.height_cm,
      weightKg: c.weight_kg,
      activityLevel: c.activity_level,
      goal: c.goal,
      paceKgPerWeek: c.pace_kg_per_week,
    });
    expect(plan.bmr).toBeCloseTo(c.bmr, 6);
    expect(plan.tdee).toBeCloseTo(c.tdee, 6);
    expect(plan.kcal).toBeCloseTo(c.kcal, 6);
    expect(plan.proteinG).toBeCloseTo(c.protein_g, 6);
    expect(plan.carbsG).toBeCloseTo(c.carbs_g, 6);
    expect(plan.fatG).toBeCloseTo(c.fat_g, 6);
    expect(plan.floored).toBe(c.floored);
  });
});

describe("availablePaces", () => {
  // A stop the server would reject must never be offered. The cap is 1% of
  // bodyweight per week.
  it("offers only stops at or under one percent of bodyweight", () => {
    expect(availablePaces(84)).toEqual([0.25, 0.5, 0.75]);
    expect(availablePaces(50)).toEqual([0.25, 0.5]);
    expect(availablePaces(120)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("always offers at least the slowest stop", () => {
    expect(availablePaces(20)).toEqual([0.25]);
  });
});

describe("weeksToGoal", () => {
  it("rounds up to whole weeks", () => {
    expect(weeksToGoal(84, 78, 0.5)).toBe(12);
    expect(weeksToGoal(84, 77.9, 0.5)).toBe(13);
  });

  it("returns zero when already at the goal", () => {
    expect(weeksToGoal(78, 78, 0.5)).toBe(0);
  });

  it("works for gaining as well as losing", () => {
    expect(weeksToGoal(70, 75, 0.25)).toBe(20);
  });
});
