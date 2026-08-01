import { inferActivityLevel } from "../inferActivity";

const days = (n: number, steps: number) => Array.from({ length: n }, () => steps);

test.each([
  [3000, "sedentary"],
  [4999, "sedentary"],
  [5000, "light"],
  [7499, "light"],
  [7500, "moderate"],
  [9999, "moderate"],
  [10000, "active"],
  [12499, "active"],
  [12500, "very_active"],
  [20000, "very_active"],
])("%i mean steps/day with no workouts infers %s", (steps, expected) => {
  const out = inferActivityLevel({ dailySteps: days(14, steps), workoutsPerWeek: 0, daysObserved: 14 });
  expect(out?.level).toBe(expected);
});

test("training load lifts a low-step user, which is the whole reason workouts are read", () => {
  // A lifter: 3,000 steps a day but five sessions a week. On steps alone this is
  // "sedentary", which is exactly wrong for the Build-muscle cohort.
  const stepsOnly = inferActivityLevel({ dailySteps: days(14, 3000), workoutsPerWeek: 0, daysObserved: 14 });
  expect(stepsOnly?.level).toBe("sedentary");

  const withTraining = inferActivityLevel({ dailySteps: days(14, 3000), workoutsPerWeek: 5, daysObserved: 14 });
  expect(withTraining?.level).toBe("moderate"); // sedentary +2
});

test("3 workouts a week lifts exactly one level", () => {
  const out = inferActivityLevel({ dailySteps: days(14, 6000), workoutsPerWeek: 3, daysObserved: 14 });
  expect(out?.level).toBe("moderate"); // light +1
});

test("the training bump is capped at very_active and cannot overflow", () => {
  const out = inferActivityLevel({ dailySteps: days(14, 20000), workoutsPerWeek: 7, daysObserved: 14 });
  expect(out?.level).toBe("very_active");
});

// Absent data must never resolve to a level. This repo already spent a PR undoing
// three signals that read missing data as evidence; a "sedentary" floor would
// repeat that, and it biases the calorie target downward.
test("too few observed days yields null rather than a guess", () => {
  expect(inferActivityLevel({ dailySteps: days(6, 9000), workoutsPerWeek: 2, daysObserved: 6 })).toBeNull();
});

test("no step samples at all yields null, NOT sedentary", () => {
  expect(inferActivityLevel({ dailySteps: [], workoutsPerWeek: 0, daysObserved: 14 })).toBeNull();
});

test("all-zero step days yield null, NOT sedentary", () => {
  // A phone left on a desk reports zeros. That is absence of evidence, not
  // evidence of a sedentary life.
  expect(inferActivityLevel({ dailySteps: days(14, 0), workoutsPerWeek: 0, daysObserved: 14 })).toBeNull();
});

test("exactly 7 observed days is enough", () => {
  expect(
    inferActivityLevel({ dailySteps: days(7, 8000), workoutsPerWeek: 0, daysObserved: 7 })?.level,
  ).toBe("moderate");
});

test("the reason states what was observed, so the inference is never unexplained", () => {
  const out = inferActivityLevel({ dailySteps: days(14, 8400), workoutsPerWeek: 4, daysObserved: 14 });
  expect(out?.reason).toContain("8,400");
  expect(out?.reason).toContain("4");
});

test("negative or non-finite step values are ignored rather than skewing the mean", () => {
  const clean = inferActivityLevel({ dailySteps: days(14, 8000), workoutsPerWeek: 0, daysObserved: 14 });
  const dirty = inferActivityLevel({
    dailySteps: [...days(14, 8000), -5000, Number.NaN, Number.POSITIVE_INFINITY],
    workoutsPerWeek: 0,
    daysObserved: 14,
  });
  expect(dirty?.level).toBe(clean?.level);
});
