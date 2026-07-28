import { fibreGoal } from "../fibreGoal";

test("14g per 1000 kcal, rounded", () => {
  expect(fibreGoal(2000)).toBe(28);
  expect(fibreGoal(2750)).toBe(39); // 14 * 2750 / 1000 = 38.5 -> 39
});

test("falls back to 30 when the calorie target is missing or non-positive", () => {
  expect(fibreGoal(0)).toBe(30);
  expect(fibreGoal(-100)).toBe(30);
});
