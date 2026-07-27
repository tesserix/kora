import { validateOnboardingNumbers } from "../validateOnboarding";

test("rejects empty fields", () => {
  expect(validateOnboardingNumbers("", "180", "80")).toBeTruthy();
});

test("rejects non-numeric", () => {
  expect(validateOnboardingNumbers("abc", "180", "80")).toBeTruthy();
});

test("rejects out-of-range", () => {
  expect(validateOnboardingNumbers("1995", "0", "80")).toBeTruthy();
  expect(validateOnboardingNumbers("1700", "180", "80")).toBeTruthy();
});

test("accepts valid input", () => {
  expect(validateOnboardingNumbers("1995", "180", "80")).toBeNull();
});

test("range messages default to metric units", () => {
  expect(validateOnboardingNumbers("1995", "0", "80")).toBe("Please enter a valid height in cm.");
  expect(validateOnboardingNumbers("1995", "180", "0")).toBe("Please enter a valid weight in kg.");
});

test("range messages use imperial unit labels when provided", () => {
  expect(validateOnboardingNumbers("1995", "0", "80", { heightUnit: "ft/in", weightUnit: "lb" })).toBe(
    "Please enter a valid height in ft/in.",
  );
  expect(validateOnboardingNumbers("1995", "180", "0", { heightUnit: "ft/in", weightUnit: "lb" })).toBe(
    "Please enter a valid weight in lb.",
  );
});
