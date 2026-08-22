import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MealPlanProposal } from "@/api/types";
import {
  activateMealPlanProjection,
  deactivateMealPlanProjection,
  loadActiveMealPlanProjection,
  loadMealPlanProjection,
} from "../mealPlanProjection";

const plan: MealPlanProposal = {
  id: "plan-a",
  summary: "Reviewed plan",
  days: [{
    date: "Any day label",
    meals: [{
      name: "Lentil bowl",
      description: "Reviewed local option",
      preparation: "Simmer lentils and serve with roasted vegetables.",
    }],
  }],
  agent_name: "Kora Meal Planner",
  reviewed_by: "Kora Nutrition Coach",
  accepted_at: "2026-08-22T06:00:00Z",
  starts_on: "2026-08-22",
  timezone: "Australia/Melbourne",
  created_at: "2026-08-22T05:00:00Z",
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

test("accepted plan projections stay isolated by account and only the active owner schedules", async () => {
  await activateMealPlanProjection("user-a", plan);
  await activateMealPlanProjection("user-b", { ...plan, id: "plan-b", summary: "Other plan" });

  expect(await loadMealPlanProjection("user-a")).toEqual(plan);
  expect(await loadActiveMealPlanProjection()).toEqual({ ...plan, id: "plan-b", summary: "Other plan" });

  await deactivateMealPlanProjection();
  expect(await loadActiveMealPlanProjection()).toBeNull();
});

test("an unaccepted plan can never become an active reminder projection", async () => {
  await activateMealPlanProjection("user-a", {
    ...plan,
    accepted_at: null,
    starts_on: null,
    timezone: "",
  });

  expect(await loadActiveMealPlanProjection()).toBeNull();
});
