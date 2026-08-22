import * as Notifications from "expo-notifications";
import type { Weekday } from "../customPrefs";
import { applyAllReminders, buildMentorSchedule } from "../schedule";
import { loadActiveMentorProjection, type MentorProjection } from "@/mentor/projection";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn().mockResolvedValue("notification-id"),
  SchedulableTriggerInputTypes: { DAILY: "daily", WEEKLY: "weekly", DATE: "date" },
}));

jest.mock("@/mentor/projection", () => ({
  loadActiveMentorProjection: jest.fn(),
  deactivateMentorProjection: jest.fn(),
}));

const ALL_MEALS_OFF = {
  breakfast: { enabled: false, hour: 8, minute: 0 },
  lunch: { enabled: false, hour: 12, minute: 30 },
  dinner: { enabled: false, hour: 18, minute: 30 },
  snack: { enabled: false, hour: 15, minute: 0 },
};

const NO_WEIGHT = {
  pref: { enabled: false, hour: 7, minute: 0, days: [1] as Weekday[] },
  lastWeighedAt: null,
  now: new Date(2026, 7, 24, 5, 0),
};

const projection: MentorProjection = {
  profile: { quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60 },
  commitments: [{
    id: "water-1",
    title: "Drink a glass of water",
    kind: "hydration",
    cadence: "interval",
    weekdays_mask: 1 << 1,
    start_minute: 6 * 60,
    interval_minutes: 120,
    end_minute: 10 * 60,
    timezone: "Australia/Melbourne",
    starts_on: "2026-08-24",
    ends_on: null,
    status: "active",
  }, {
    id: "proposal-1",
    title: "Unconfirmed plan",
    kind: "walking",
    cadence: "fixed",
    weekdays_mask: 127,
    start_minute: 9 * 60,
    interval_minutes: null,
    end_minute: null,
    timezone: "Australia/Melbourne",
    starts_on: "2026-08-24",
    ends_on: null,
    status: "paused",
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  (loadActiveMentorProjection as jest.Mock).mockResolvedValue(projection);
});

test("mentor schedule includes only active weekday occurrences outside quiet hours", () => {
  const notifications = buildMentorSchedule(projection, new Date(2026, 7, 24, 5, 0), 1);

  expect(notifications.map((item) => item.trigger)).toEqual([
    { type: "weekly", weekday: 2, hour: 8, minute: 0 },
    { type: "weekly", weekday: 2, hour: 10, minute: 0 },
  ]);
  expect(notifications.map((item) => item.content.data)).toEqual([
    { kind: "mentor", commitmentId: "water-1" },
    { kind: "mentor", commitmentId: "water-1" },
  ]);
  expect(notifications.every((item) => item.content.categoryIdentifier === "mentor-commitment")).toBe(true);
});

test("open-ended commitments use recurring triggers that do not expire after seven days", () => {
  const notifications = buildMentorSchedule({
    profile: projection.profile,
    commitments: [{
      ...projection.commitments[1],
      id: "daily-walk",
      title: "Morning walk",
      status: "active",
      starts_on: "2026-08-24",
    }],
  }, new Date(2026, 7, 24, 5, 0), 1);

  expect(notifications).toHaveLength(1);
  expect((notifications[0] as unknown as { trigger: unknown }).trigger).toEqual({
    type: "daily",
    hour: 9,
    minute: 0,
  });
  expect(notifications[0].content.data).toEqual({
    kind: "mentor",
    commitmentId: "daily-walk",
  });
});

test("the existing all-reminders reconcile also projects confirmed mentor commitments", async () => {
  await applyAllReminders(ALL_MEALS_OFF, [], NO_WEIGHT);

  expect(loadActiveMentorProjection).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.objectContaining({ data: expect.objectContaining({ kind: "mentor", commitmentId: "water-1" }) }),
    trigger: expect.objectContaining({ type: "weekly" }),
  }));
});
