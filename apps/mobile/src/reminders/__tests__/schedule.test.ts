import { buildSchedule, applyReminders } from "../schedule";
import { DEFAULT_PREFS } from "../prefs";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: "daily" },
}));

test("buildSchedule includes only enabled slots, with per-slot copy", () => {
  const s = buildSchedule(DEFAULT_PREFS); // breakfast/lunch/dinner on, snack off
  expect(s.map((r) => r.slot)).toEqual(["breakfast", "lunch", "dinner"]);
  const bfast = s.find((r) => r.slot === "breakfast")!;
  expect(bfast).toMatchObject({ hour: 8, minute: 0 });
  expect(bfast.title.length).toBeGreaterThan(0);
  expect(bfast.body.length).toBeGreaterThan(0);
});

test("buildSchedule returns [] when all slots disabled", () => {
  const off = {
    breakfast: { enabled: false, hour: 8, minute: 0 },
    lunch: { enabled: false, hour: 12, minute: 30 },
    dinner: { enabled: false, hour: 18, minute: 30 },
    snack: { enabled: false, hour: 15, minute: 0 },
  };
  expect(buildSchedule(off)).toEqual([]);
});

test("applyReminders cancels all then schedules one per enabled slot", async () => {
  await applyReminders(DEFAULT_PREFS);
  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "reminder", slot: "breakfast" } }),
      trigger: { type: "daily", hour: 8, minute: 0 },
    }),
  );
});
