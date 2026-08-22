import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { currentUserId } from "@/lib/api";
import { useMentorCommitments, useMentorProfile } from "@/api/hooks";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { activateMentorProjection, saveMentorProjection } from "../projection";
import { useMentorRuntime } from "../useMentorRuntime";
import { collectMentorHealthDays } from "../healthSync";
import { pauseMentorHealthSync } from "../healthSyncGate";
import { flushMentorCheckIns } from "../checkInOutbox";
import { useIsOnline } from "@/offline/connectivity";

jest.mock("@/lib/api", () => ({ currentUserId: jest.fn(() => "user-a") }));
jest.mock("@/api/hooks", () => ({
  useMentorProfile: jest.fn(),
  useMentorCommitments: jest.fn(),
  useSyncMentorHealth: jest.fn(() => ({ mutateAsync: jest.fn() })),
}));
jest.mock("@/reminders/reconcileWeightReminder", () => ({ reconcileWeightReminder: jest.fn() }));
jest.mock("../projection", () => ({
  activateMentorProjection: jest.fn(),
  saveMentorProjection: jest.fn(),
}));
jest.mock("../healthSync", () => ({ collectMentorHealthDays: jest.fn() }));
jest.mock("../checkInOutbox", () => ({ flushMentorCheckIns: jest.fn(async () => ({ sent: 0, pending: 0 })) }));
jest.mock("@/offline/connectivity", () => ({ useIsOnline: jest.fn(() => true) }));

const { useSyncMentorHealth } = jest.requireMock("@/api/hooks") as { useSyncMentorHealth: jest.Mock };
let appStateHandlers: ((state: string) => void)[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, handler: (state: string) => void) => {
    if (type === "change") appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
  useSyncMentorHealth.mockReturnValue({ mutateAsync: jest.fn() });
  (currentUserId as jest.Mock).mockReturnValue("user-a");
  (useIsOnline as jest.Mock).mockReturnValue(true);
  (useMentorProfile as jest.Mock).mockReturnValue({ data: {
    motivation: "Private motivation",
    dietary_preferences: "Private diet",
    allergies: "Private allergy",
    quiet_start_minute: 1320,
    quiet_end_minute: 420,
    health_steps_enabled: false,
    health_sleep_enabled: false,
    health_workouts_enabled: false,
  } });
  (useMentorCommitments as jest.Mock).mockReturnValue({ data: [{
    id: "c1",
    title: "Walk after work",
    kind: "walking",
    cadence: "fixed",
    weekdays_mask: 127,
    start_minute: 1080,
    interval_minutes: null,
    end_minute: null,
    timezone: "Australia/Melbourne",
    starts_on: "2026-08-22T00:00:00Z",
    ends_on: null,
    status: "active",
    source: "user",
    agent_name: null,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  }] });
});

test("queued notification check-ins retry on reconnect and foreground", async () => {
  (useIsOnline as jest.Mock).mockReturnValue(false);
  const hook = await renderHook(() => useMentorRuntime());
  expect(flushMentorCheckIns).not.toHaveBeenCalled();

  (useIsOnline as jest.Mock).mockReturnValue(true);
  hook.rerender({});
  await waitFor(() => expect(flushMentorCheckIns).toHaveBeenCalledTimes(1));

  await act(async () => {
    appStateHandlers.forEach((handler) => handler("active"));
  });
  await waitFor(() => expect(flushMentorCheckIns).toHaveBeenCalledTimes(2));
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("mentor runtime stores only the signed-in account's minimal reminder projection", async () => {
  await renderHook(() => useMentorRuntime());

  await waitFor(() => expect(reconcileWeightReminder).toHaveBeenCalledTimes(1));
  expect(saveMentorProjection).toHaveBeenCalledWith("user-a", {
    profile: { quiet_start_minute: 1320, quiet_end_minute: 420 },
    commitments: [expect.objectContaining({ id: "c1", title: "Walk after work", status: "active" })],
  });
  expect(JSON.stringify((saveMentorProjection as jest.Mock).mock.calls[0][1])).not.toContain("Private");
  expect(activateMentorProjection).toHaveBeenCalledWith("user-a");
});

test("confirmed Health consent syncs on mount and again after a later foreground", async () => {
  const mutateAsync = jest.fn().mockResolvedValue({ synced: 1 });
  useSyncMentorHealth.mockReturnValue({ mutateAsync });
  (useMentorProfile as jest.Mock).mockReturnValue({ data: {
    quiet_start_minute: 1320,
    quiet_end_minute: 420,
    confirmed_at: "2026-08-22T00:00:00Z",
    health_steps_enabled: true,
    health_sleep_enabled: false,
    health_workouts_enabled: true,
  } });
  (collectMentorHealthDays as jest.Mock).mockResolvedValue({
    status: "ready",
    days: [{ local_date: "2026-08-22", timezone: "Australia/Melbourne", steps: 7000, observed_at: "now" }],
  });
  let now = new Date("2026-08-22T10:00:00Z").getTime();
  jest.spyOn(Date, "now").mockImplementation(() => now);

  await renderHook(() => useMentorRuntime());
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

  now += 16 * 60 * 1000;
  await act(async () => {
    appStateHandlers.forEach((handler) => handler("active"));
  });

  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  expect(collectMentorHealthDays).toHaveBeenCalledWith({ steps: true, sleep: false, workouts: true });
});

test("a Health read started before consent revocation cannot upload afterward", async () => {
  const mutateAsync = jest.fn();
  useSyncMentorHealth.mockReturnValue({ mutateAsync });
  (useMentorProfile as jest.Mock).mockReturnValue({ data: {
    quiet_start_minute: 1320,
    quiet_end_minute: 420,
    confirmed_at: "2026-08-22T00:00:00Z",
    health_steps_enabled: true,
    health_sleep_enabled: false,
    health_workouts_enabled: false,
  } });
  let finishCollection!: (value: unknown) => void;
  (collectMentorHealthDays as jest.Mock).mockReturnValue(new Promise((resolve) => { finishCollection = resolve; }));

  await renderHook(() => useMentorRuntime());
  await waitFor(() => expect(collectMentorHealthDays).toHaveBeenCalledTimes(1));
  const pause = pauseMentorHealthSync();
  pause.resume();
  await act(async () => {
    finishCollection({
      status: "ready",
      days: [{ local_date: "2026-08-22", timezone: "Australia/Melbourne", steps: 7000, observed_at: "now" }],
    });
  });

  expect(mutateAsync).not.toHaveBeenCalled();
});
