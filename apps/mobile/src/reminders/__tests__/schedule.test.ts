import { buildSchedule, buildCustomSchedule, applyAllReminders } from "../schedule";
import { DEFAULT_PREFS } from "../prefs";
import type { CustomReminder } from "../customPrefs";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: "daily", WEEKLY: "weekly" },
}));

const everyDay: CustomReminder = { id: "w", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true };
const mwf: CustomReminder = { id: "g", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5], enabled: true };
const off: CustomReminder = { id: "x", label: "Off one", hour: 9, minute: 0, days: [2], enabled: false };

beforeEach(() => {
  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockReset();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockReset();
});

test("buildSchedule still lists only enabled meal slots", () => {
  expect(buildSchedule(DEFAULT_PREFS).map((r) => r.slot)).toEqual(["breakfast", "lunch", "dinner"]);
});

test("buildCustomSchedule: all-7-days -> one daily trigger; label as title; custom payload", () => {
  const s = buildCustomSchedule([everyDay]);
  expect(s).toHaveLength(1);
  expect(s[0].title).toBe("Drink water");
  expect(s[0].data).toEqual({ kind: "custom", id: "w" });
  expect(s[0].trigger).toEqual({ type: "daily", hour: 15, minute: 0 });
});

test("buildCustomSchedule: weekday subset -> one weekly trigger per day (expo weekday = jsDay+1)", () => {
  const s = buildCustomSchedule([mwf]);
  expect(s).toHaveLength(3);
  expect(s.map((n) => n.trigger)).toEqual([
    { type: "weekly", weekday: 2, hour: 7, minute: 30 }, // Mon js1 -> expo2
    { type: "weekly", weekday: 4, hour: 7, minute: 30 }, // Wed js3 -> expo4
    { type: "weekly", weekday: 6, hour: 7, minute: 30 }, // Fri js5 -> expo6
  ]);
});

test("buildCustomSchedule excludes disabled reminders and returns [] for none", () => {
  expect(buildCustomSchedule([off])).toEqual([]);
  expect(buildCustomSchedule([])).toEqual([]);
});

test("applyAllReminders cancels once then schedules meals + customs together", async () => {
  await applyAllReminders(DEFAULT_PREFS, [everyDay, mwf]);
  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  // 3 meals (bfast/lunch/dinner) + 1 daily custom + 3 weekly customs = 7
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(7);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "reminder", slot: "breakfast" } }),
      trigger: { type: "daily", hour: 8, minute: 0 },
    }),
  );
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "custom", id: "g" } }),
      trigger: { type: "weekly", weekday: 2, hour: 7, minute: 30 },
    }),
  );
});
