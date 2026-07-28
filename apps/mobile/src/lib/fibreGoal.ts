// fibreGoal derives a daily fibre target from the user's calorie target using
// the standard dietary guideline of 14 g of fibre per 1000 kcal. Falls back to
// 30 g (a common general recommendation) when the calorie target is missing or
// non-positive, so callers never divide by zero or show a "/ 0" goal.
export function fibreGoal(kcalTarget: number): number {
  if (kcalTarget > 0) return Math.round((14 * kcalTarget) / 1000);
  return 30;
}
