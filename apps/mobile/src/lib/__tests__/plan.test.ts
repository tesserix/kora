import { readFileSync } from "fs";
import { join } from "path";
import {
  availablePaces,
  computePlan,
  proteinFactor,
  weeksToGoal,
  type PlanInput,
} from "../plan";

type GoldenCase = {
  name: string;
  sex: "male" | "female";
  age: number;
  height_cm: number;
  weight_kg: number;
  activity_level: PlanInput["activityLevel"];
  goal: PlanInput["goal"];
  pace_kg_per_week: number;
  goal_weight_kg?: number;
  kcal_override?: number;
  protein_override_g?: number;
  override_error?: string;
  bmr: number;
  tdee: number;
  kcal: number;
  protein_g: number;
  protein_g_per_kg: number;
  carbs_g: number;
  fat_g: number;
  floored: boolean;
};

const goldenCases = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../../../api/internal/onboarding/testdata/golden_targets.json",
    ),
    "utf8",
  ),
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
      goalWeightKg: c.goal_weight_kg,
      kcalOverride: c.kcal_override,
      proteinOverrideG: c.protein_override_g,
    });
    expect(plan.overrideError).toBe(c.override_error ?? null);
    if (c.override_error) return;
    expect(plan.kcalOverridden).toBe(c.kcal_override !== undefined);
    expect(plan.proteinOverridden).toBe(c.protein_override_g !== undefined);
    expect(plan.bmr).toBeCloseTo(c.bmr, 6);
    expect(plan.tdee).toBeCloseTo(c.tdee, 6);
    expect(plan.kcal).toBeCloseTo(c.kcal, 6);
    expect(plan.proteinG).toBeCloseTo(c.protein_g, 6);
    expect(plan.proteinGPerKg).toBeCloseTo(c.protein_g_per_kg, 6);
    expect(plan.carbsG).toBeCloseTo(c.carbs_g, 6);
    expect(plan.fatG).toBeCloseTo(c.fat_g, 6);
    expect(plan.floored).toBe(c.floored);
  });
});

describe("proteinFactor", () => {
  const levels = [
    "sedentary",
    "light",
    "moderate",
    "active",
    "very_active",
  ] as const;
  const table = {
    fat_loss: [1.6, 1.6, 1.8, 1.8, 1.8],
    maintenance: [1.2, 1.4, 1.6, 1.6, 1.6],
    muscle_gain: [1.8, 1.8, 2.0, 2.0, 2.0],
  } as const;
  const cells = (Object.keys(table) as (keyof typeof table)[]).flatMap((goal) =>
    levels.map((level, i) => [goal, level, table[goal][i]] as const),
  );
  it.each(cells)("%s / %s is %f g/kg", (goal, level, want) => {
    expect(proteinFactor(goal, level)).toBe(want);
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

describe("computePlan guards", () => {
  it("treats a negative pace as no adjustment rather than inverting the goal", () => {
    const base = {
      sex: "male",
      age: 31,
      heightCm: 178,
      weightKg: 84,
      activityLevel: "moderate",
      goal: "fat_loss",
    } as const;
    const negative = computePlan({ ...base, paceKgPerWeek: -0.5 });
    const zero = computePlan({ ...base, paceKgPerWeek: 0 });
    expect(negative.kcal).toBeCloseTo(zero.kcal, 6);
    expect(negative.kcal).toBeLessThanOrEqual(negative.tdee);
  });

  it("never returns a target below resting burn", () => {
    const plan = computePlan({
      sex: "female",
      age: 90,
      heightCm: 150,
      weightKg: 40,
      activityLevel: "sedentary",
      goal: "fat_loss",
      paceKgPerWeek: 0.4,
    });
    expect(plan.kcal).toBeCloseTo(plan.bmr, 6);
    expect(plan.floored).toBe(true);
  });
});

describe("computePlan with a bad override", () => {
  const tester: PlanInput = {
    sex: "female",
    age: 36,
    heightCm: 160,
    weightKg: 73,
    activityLevel: "light",
    goal: "fat_loss",
    paceKgPerWeek: 0.25,
    goalWeightKg: 68,
  };
  const heavy: PlanInput = {
    sex: "female",
    age: 60,
    heightCm: 160,
    weightKg: 200,
    activityLevel: "sedentary",
    goal: "maintenance",
    paceKgPerWeek: 0,
  };
  it("drops only the failing kcal override and keeps a valid protein one", () => {
    const plain = computePlan(tester);
    const plan = computePlan({
      ...tester,
      kcalOverride: 1388,
      proteinOverrideG: 125,
    });
    expect(plan.overrideError).toBe("kcal_below_resting_burn");
    expect(plan.kcalOverridden).toBe(false);
    expect(plan.proteinOverridden).toBe(true);
    expect(plan.kcal).toBe(plain.kcal);
    expect(plan.proteinG).toBe(125);
  });
  it("reports the protein code when the surviving protein override fails against the plain kcal", () => {
    const plan = computePlan({
      ...heavy,
      goal: "fat_loss",
      paceKgPerWeek: 2,
      kcalOverride: 1,
      proteinOverrideG: 500,
    });
    expect(plan.overrideError).toBe("protein_exceeds_share");
    expect(plan.kcalOverridden).toBe(false);
    expect(plan.proteinOverridden).toBe(false);
  });
  it("keeps a valid kcal override when protein fails the share check", () => {
    const plan = computePlan({
      ...heavy,
      kcalOverride: 2539,
      proteinOverrideG: 500,
    });
    expect(plan.overrideError).toBe("protein_exceeds_share");
    expect(plan.kcalOverridden).toBe(true);
    expect(plan.proteinOverridden).toBe(false);
    expect(plan.kcal).toBe(2539);
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects a non-finite override (%f)",
    (v) => {
      expect(computePlan({ ...tester, kcalOverride: v }).overrideError).toBe(
        "kcal_below_resting_burn",
      );
      expect(
        computePlan({ ...tester, proteinOverrideG: v }).overrideError,
      ).toBe("protein_below_min");
      expect(computePlan({ ...tester, kcalOverride: v }).kcalOverridden).toBe(
        false,
      );
    },
  );
});
