import { buildMealPlanSchedule } from "../schedule";
import type { MealPlanProposal } from "@/api/types";
import { DEFAULT_PREFS } from "../prefs";

const plan: MealPlanProposal = {
  id: "plan-1",
  summary: "Reviewed plan",
  days: [
    {
      date: "Training day",
      meals: [
        {
          name: "Oats and yoghurt",
          description: "Reviewed breakfast",
          preparation: "Simmer oats, cool slightly, then fold through yoghurt.",
        },
        {
          name: "Lentil bowl",
          description: "Reviewed dinner",
          preparation: "Simmer lentils and serve with roasted vegetables.",
        },
      ],
    },
    {
      date: "Rest day",
      meals: [{
        name: "Tofu rice bowl",
        description: "Reviewed meal",
        preparation: "Pan-sear tofu and serve over rice.",
      }],
    },
  ],
  agent_name: "Kora Meal Planner",
  reviewed_by: "Kora Plan Supervisor",
  accepted_at: "2026-08-22T06:00:00Z",
  starts_on: "2026-08-24",
  timezone: "Australia/Melbourne",
  created_at: "2026-08-22T05:00:00Z",
};

test("an accepted plan schedules one concrete daily coach reminder at the user's first enabled meal time", () => {
  const reminders = buildMealPlanSchedule(
    plan,
    DEFAULT_PREFS,
    new Date(2026, 7, 24, 7, 0),
    7,
  );

  expect(reminders).toHaveLength(2);
  expect(reminders[0]).toEqual({
    content: {
      title: "Training day · today's reviewed plan",
      body: "Oats and yoghurt · Lentil bowl",
      data: { kind: "meal-plan", planId: "plan-1", dayIndex: 0 },
    },
    trigger: { type: "date", date: new Date(2026, 7, 24, 8, 0) },
  });
  expect(reminders[1].trigger).toEqual({ type: "date", date: new Date(2026, 7, 25, 8, 0) });
});

test("arbitrary day labels are display data and a plan never schedules past its final day", () => {
  const reminders = buildMealPlanSchedule(
    plan,
    DEFAULT_PREFS,
    new Date(2026, 7, 25, 9, 0),
    62,
  );

  expect(reminders).toEqual([]);
});

test("a user who disabled every meal reminder gets no silently guessed plan time", () => {
  const disabled = Object.fromEntries(
    Object.entries(DEFAULT_PREFS).map(([slot, pref]) => [slot, { ...pref, enabled: false }]),
  ) as typeof DEFAULT_PREFS;

  expect(buildMealPlanSchedule(plan, disabled, new Date(2026, 7, 24, 7, 0), 7)).toEqual([]);
});
