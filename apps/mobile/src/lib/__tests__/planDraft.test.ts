import { draftFromParams, draftToParams, type PlanDraft } from "../planDraft";

const draft: PlanDraft = {
  timezone: "Europe/London",
  sex: "female",
  birth_year: 1990,
  height_cm: 165.1,
  weight_kg: 62.5,
  activity_level: "light",
  goal: "fat_loss",
  goal_weight_kg: 58,
  pace_kg_per_week: 0.5,
  target_kcal_override: 1700,
  target_protein_override_g: 120,
};

describe("planDraft", () => {
  it("round-trips a full draft through string params", () => {
    const params = draftToParams(draft);
    for (const v of Object.values(params)) expect(typeof v).toBe("string");
    expect(draftFromParams(params)).toEqual(draft);
  });

  it("omits absent and null optional fields", () => {
    const maintain: PlanDraft = {
      sex: "male",
      birth_year: 1980,
      height_cm: 180,
      weight_kg: 80,
      activity_level: "moderate",
      goal: "maintenance",
      target_kcal_override: null,
    };
    const params = draftToParams(maintain);
    expect(params).not.toHaveProperty("target_kcal_override");
    expect(params).not.toHaveProperty("goal_weight_kg");
    expect(draftFromParams(params)).toEqual({ ...maintain, target_kcal_override: undefined });
  });

  it.each(["sex", "birth_year", "height_cm", "weight_kg", "activity_level", "goal"])(
    "returns null when %s is missing",
    (key) => {
      const params: Record<string, string | undefined> = draftToParams(draft);
      delete params[key];
      expect(draftFromParams(params)).toBeNull();
    },
  );

  it.each([
    ["weight_kg", "NaN"],
    ["height_cm", "abc"],
    ["birth_year", ""],
    ["weight_kg", "Infinity"],
    ["goal_weight_kg", "x"],
    ["target_protein_override_g", "NaN"],
    ["sex", "other"],
    ["activity_level", "lazy"],
    ["goal", "bulk"],
  ])("returns null when %s is %p", (key, value) => {
    expect(draftFromParams({ ...draftToParams(draft), [key]: value })).toBeNull();
  });

  it("returns null for an array-valued param", () => {
    expect(draftFromParams({ ...draftToParams(draft), weight_kg: ["70", "80"] })).toBeNull();
  });
});
