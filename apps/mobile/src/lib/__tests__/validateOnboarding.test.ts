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
