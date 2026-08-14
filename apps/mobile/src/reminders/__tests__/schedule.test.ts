import { buildSchedule, buildCustomSchedule, applyAllReminders, cancelAllReminders, MAX_SCHEDULED_NOTIFICATIONS } from "../schedule";
import { DEFAULT_PREFS } from "../prefs";
import type { CustomReminder, Weekday } from "../customPrefs";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: "daily", WEEKLY: "weekly", DATE: "date" },
}));

const everyDay: CustomReminder = { id: "w", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true };
const mwf: CustomReminder = { id: "g", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5], enabled: true };
const off: CustomReminder = { id: "x", label: "Off one", hour: 9, minute: 0, days: [2], enabled: false };

// applyAllReminders' weight argument is mandatory (a missing one silently
// destroys the user's weight reminder, since the function opens by cancelling
// everything). Tests not about the weight reminder pass this inert input.
const NO_WEIGHT_REMINDER = {
  pref: { enabled: false, hour: 7, minute: 0, days: [1] as Weekday[] },
  lastWeighedAt: null,
  now: new Date(2026, 7, 12, 9, 0),
};

const DEFAULT_PREFS_ALL_OFF = {
  breakfast: { enabled: false, hour: 8, minute: 0 },
  lunch: { enabled: false, hour: 12, minute: 30 },
  dinner: { enabled: false, hour: 18, minute: 30 },
  snack: { enabled: false, hour: 15, minute: 0 },
};

beforeEach(() => {
  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockReset();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockReset();
});

// weightCallsOf picks out the scheduleNotificationAsync calls carrying the
// weight reminder's payload, so a test can assert on that notification
// specifically rather than on "nothing was scheduled at all".
function weightCallsOf(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(
    ([arg]) => (arg as { content: { data?: { kind?: string } } }).content.data?.kind === "weight",
  );
}

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
  await applyAllReminders(DEFAULT_PREFS, [everyDay, mwf], NO_WEIGHT_REMINDER);
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

test("applyAllReminders caps total scheduled requests at MAX_SCHEDULED_NOTIFICATIONS (meals scheduled first)", async () => {
  // 20 weekday-subset customs x 6 days = 120 potential custom notifications, far
  // over the cap even before the 3 enabled meals from DEFAULT_PREFS are counted.
  const manyCustoms: CustomReminder[] = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    label: "R" + i,
    hour: 9,
    minute: 0,
    days: [1, 2, 3, 4, 5, 6],
    enabled: true,
  }));
  expect(buildCustomSchedule(manyCustoms)).toHaveLength(120);

  await applyAllReminders(DEFAULT_PREFS, manyCustoms, NO_WEIGHT_REMINDER);

  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(MAX_SCHEDULED_NOTIFICATIONS);
});

test("the weight reminder is scheduled as a one-shot date trigger", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  await applyAllReminders(
    { breakfast: { enabled: false, hour: 8, minute: 0 }, lunch: { enabled: false, hour: 12, minute: 30 },
      dinner: { enabled: false, hour: 18, minute: 30 }, snack: { enabled: false, hour: 15, minute: 0 } },
    [],
    { pref: { enabled: true, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0) },
  );

  expect(scheduleSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ data: { kind: "weight" } }),
      trigger: expect.objectContaining({ type: Notifications.SchedulableTriggerInputTypes.DATE }),
    }),
  );
});

// Deliberately NOT asserted against an empty schedule: "nothing at all was
// scheduled" also holds if weight scheduling were deleted outright, or if
// applyAllReminders stopped scheduling anything. Meals and a custom are enabled
// here so the test can distinguish "the weight reminder specifically was
// suppressed" from "nothing happened", and the enabled counterpart below pins
// that the same setup DOES produce a weight notification — so deleting the
// weight branch fails a test.
test("a disabled weight reminder is the only thing skipped; everything else still schedules", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  await applyAllReminders(DEFAULT_PREFS, [mwf], {
    pref: { enabled: false, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0),
  });

  // 3 enabled meals + 3 weekly customs, and no weight notification.
  expect(scheduleSpy).toHaveBeenCalledTimes(6);
  expect(weightCallsOf(scheduleSpy)).toHaveLength(0);
});

test("the same schedule WITH the weight reminder enabled produces exactly one weight notification", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  await applyAllReminders(DEFAULT_PREFS, [mwf], {
    pref: { enabled: true, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0),
  });

  expect(scheduleSpy).toHaveBeenCalledTimes(7);
  expect(weightCallsOf(scheduleSpy)).toHaveLength(1);
});

// A weight reminder is also skipped — while everything else still schedules —
// when the user already weighed in on the day of the next occurrence. This is
// the whole distinguishing behaviour of the feature.
test("a weigh-in on the day of the next occurrence suppresses only the weight notification", async () => {
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");

  // Next Monday occurrence is 2026-08-17 07:00; the user weighed in that
  // morning at 06:40, so that occurrence is skipped — but the following
  // Monday's is scheduled, so a weight notification still exists.
  await applyAllReminders(DEFAULT_PREFS, [mwf], {
    pref: { enabled: true, hour: 7, minute: 0, days: [1] },
    lastWeighedAt: new Date(2026, 7, 17, 6, 40),
    now: new Date(2026, 7, 17, 6, 45),
  });

  const weightCalls = weightCallsOf(scheduleSpy);
  expect(weightCalls).toHaveLength(1);
  expect((weightCalls[0][0] as { trigger: { date: Date } }).trigger.date).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});

test("the weight reminder is dropped when the notification budget is exhausted", async () => {
  // 60 custom reminders on all seven days collapse to 60 daily triggers,
  // filling MAX_SCHEDULED_NOTIFICATIONS exactly. Meals-first ordering means the
  // weight reminder is the one that loses, which is the intended degradation.
  const scheduleSpy = jest.spyOn(Notifications, "scheduleNotificationAsync").mockResolvedValue("id");
  const many = Array.from({ length: MAX_SCHEDULED_NOTIFICATIONS }, (_, i) => ({
    id: `c${i}`, label: `R${i}`, hour: 9, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], enabled: true,
  }));

  await applyAllReminders(DEFAULT_PREFS_ALL_OFF, many, {
    pref: { enabled: true, hour: 7, minute: 0, days: [1] }, lastWeighedAt: null, now: new Date(2026, 7, 12, 9, 0),
  });

  expect(weightCallsOf(scheduleSpy)).toHaveLength(0);
});

// Regression: five call sites reach applyAllReminders — useReminderPrefs.setSlot
// and useCustomReminders.commit call it directly, three more arrive via
// reconcileWeightReminder — and the ordinary iOS permission flow drives them
// into each other (the permission alert takes the app active→inactive→active,
// firing the foreground reconcile while the hook's continuation is still
// pending). Because this function opens with cancelAllScheduledNotificationsAsync,
// two interleaved passes let the second call's cancel wipe notifications the
// first is still scheduling. The mutex must live inside applyAllReminders so
// every caller is covered, including the two that bypass the reconcile queue.
test("two concurrent applyAllReminders calls are serialised, not interleaved", async () => {
  // An event log rather than a concurrency counter: the failure mode is
  // ordering (a cancel landing in the middle of another pass's scheduling),
  // and the log states the required order exactly.
  const events: string[] = [];
  let cancels = 0;
  let releaseFirstCancel: () => void = () => {};
  const firstCancelGate = new Promise<void>((resolve) => {
    releaseFirstCancel = resolve;
  });

  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockImplementation(async () => {
    cancels++;
    events.push("cancel");
    // Hold the first pass open at its most dangerous point.
    if (cancels === 1) await firstCancelGate;
  });
  jest.spyOn(Notifications, "scheduleNotificationAsync").mockImplementation(async () => {
    events.push("schedule");
    // Yield inside the body: an unserialised second pass would slip in here.
    await Promise.resolve();
    return "id";
  });

  const first = applyAllReminders(DEFAULT_PREFS, [mwf], NO_WEIGHT_REMINDER);
  // The second caller arrives while the first is mid-pass, blocked on its cancel.
  const second = applyAllReminders(DEFAULT_PREFS, [mwf], NO_WEIGHT_REMINDER);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // The second pass has not even reached its cancel yet.
  expect(events).toEqual(["cancel"]);

  releaseFirstCancel();
  await Promise.all([first, second]);

  // Exactly two complete, non-overlapping passes: 3 meals + 3 weekly customs each.
  const pass = ["cancel", ...Array(6).fill("schedule")];
  expect(events).toEqual([...pass, ...pass]);
});

// --- cancelAllReminders (#171) --------------------------------------------
//
// Deleting an account (or signing out) left every local reminder the user had
// configured armed in the OS. A "log dinner" notification then fired for an
// account that no longer existed. Nothing in the app disarmed them, because
// both exit paths only ever addressed REMOTE push.

test("cancelAllReminders clears every scheduled local notification", async () => {
  await cancelAllReminders();
  expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

// It runs on the same serialisation queue as applyAllReminders. Without that,
// a sign-out cancel could land in the middle of a reconcile pass and the
// reconcile's remaining scheduleNotificationAsync calls would re-arm reminders
// for the user who just left.
test("cancelAllReminders is serialised behind an in-flight apply, so nothing is re-armed after it", async () => {
  const events: string[] = [];
  let releaseFirstCancel: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirstCancel = resolve;
  });
  let cancels = 0;

  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockImplementation(async () => {
    cancels++;
    events.push(cancels === 1 ? "apply-cancel" : "signout-cancel");
    if (cancels === 1) await gate;
  });
  (Notifications.scheduleNotificationAsync as jest.Mock).mockImplementation(async () => {
    events.push("schedule");
    return "id";
  });

  const apply = applyAllReminders(DEFAULT_PREFS_ALL_OFF, [mwf], NO_WEIGHT_REMINDER);
  const cancel = cancelAllReminders();

  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["apply-cancel"]);

  releaseFirstCancel();
  await Promise.all([apply, cancel]);

  // The sign-out cancel is LAST: no schedule call follows it.
  expect(events[events.length - 1]).toBe("signout-cancel");
});

// Best-effort, like every other push side effect in this app: a failed cancel
// must never reject into a sign-out or an account deletion.
test("cancelAllReminders resolves instead of rejecting when the OS call fails", async () => {
  (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock).mockRejectedValueOnce(
    new Error("notification service unavailable"),
  );
  await expect(cancelAllReminders()).resolves.toBeUndefined();
});
