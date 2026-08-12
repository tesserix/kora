import { validateGoalWeight, validateOnboardingNumbers } from "../validateOnboarding";

describe("validateOnboardingNumbers", () => {
  it("accepts a complete metric set", () => {
    expect(validateOnboardingNumbers("31", "178", "84")).toBeNull();
  });

  it("names every missing field at once", () => {
    expect(validateOnboardingNumbers("", "178", "")).toBe(
      "Please fill in your age, height, and weight.",
    );
  });

  it("rejects non-numeric input", () => {
    expect(validateOnboardingNumbers("thirty", "178", "84")).toBe(
      "Age, height, and weight must be numbers.",
    );
  });

  it("rejects an age outside the range the formula supports", () => {
    expect(validateOnboardingNumbers("12", "178", "84")).toBe("Please enter an age between 13 and 120.");
    expect(validateOnboardingNumbers("130", "178", "84")).toBe("Please enter an age between 13 and 120.");
  });

  it("reports height and weight in the user's own units", () => {
    expect(validateOnboardingNumbers("31", "300", "84")).toBe("Please enter a valid height in cm.");
    expect(
      validateOnboardingNumbers("31", "300", "84", { heightUnit: "ft/in", weightUnit: "lb" }),
    ).toBe("Please enter a valid height in ft/in.");
  });

  it("rejects a current weight below the goal-weight plausibility floor", () => {
    expect(validateOnboardingNumbers("31", "178", "15")).toBe("Please enter a valid weight in kg.");
  });
});

describe("validateGoalWeight", () => {
  it("passes when losing toward a lower weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 78)).toBeNull();
  });

  // A contradiction the user can see on screen should be caught in the field,
  // not by the server.
  it("rejects a fat-loss goal above current weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 90)).toBe(
      "Your goal weight is above your current weight. Pick Build muscle instead, or lower the goal.",
    );
  });

  it("rejects a muscle-gain goal below current weight", () => {
    expect(validateGoalWeight("muscle_gain", 70, 65)).toBe(
      "Your goal weight is below your current weight. Pick Lose weight instead, or raise the goal.",
    );
  });

  it("ignores the goal weight entirely when maintaining, even an impossible one", () => {
    // 5kg would fail the plausibility floor. Returning null proves the
    // maintenance short-circuit runs BEFORE the range check, which is the
    // guarantee: a maintenance user's goal weight is meaningless and must
    // never produce an error.
    expect(validateGoalWeight("maintenance", 84, 5)).toBeNull();
    expect(validateGoalWeight("maintenance", 84, 600)).toBeNull();
  });

  it("rejects an implausible goal weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 10, "kg")).toBe("Please enter a valid goal weight in kg.");
  });
});
