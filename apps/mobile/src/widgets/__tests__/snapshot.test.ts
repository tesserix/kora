import type { DashboardSummary } from "@/api/types";
import { buildSnapshot } from "../snapshot";

const summary: DashboardSummary = {
  date: "2026-08-11",
  consumed: { kcal: 1200.4, protein_g: 60.7, carbs_g: 130.2, fat_g: 40.9, fiber_g: 12.1 },
  targets: { kcal: 2451, protein_g: 156, carbs_g: 337, fat_g: 73, fiber_g: 30 },
  water_ml: 500,
  streak_days: 3,
  source_counts: {},
};

test("carries the dashboard's own date, not today's", () => {
  // The widget's staleness guard compares this to the current local day, so it
  // must describe the day the FIGURES are for — never when they were written.
  expect(buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" }).date).toBe("2026-08-11");
});

test("rounds every figure to a whole number", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" });
  expect(snapshot.kcalConsumed).toBe(1200);
  expect(snapshot.kcalTarget).toBe(2451);
  expect(snapshot.proteinConsumed).toBe(61);
  expect(snapshot.carbsConsumed).toBe(130);
  expect(snapshot.fatConsumed).toBe(41);
});

test("carries the macro targets", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" });
  expect(snapshot.proteinTarget).toBe(156);
  expect(snapshot.carbsTarget).toBe(337);
  expect(snapshot.fatTarget).toBe(73);
});

// The widget cannot discover either of these for itself — see the spec's
// "Why the snapshot carries health state".
test("carries the step goal and health status", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "denied" });
  expect(snapshot.stepGoal).toBe(10000);
  expect(snapshot.healthStatus).toBe("denied");
});
