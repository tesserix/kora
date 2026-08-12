import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useReminderPrefs } from "../useReminderPrefs";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../prefs";
import { applyAllReminders } from "../schedule";
import { DEFAULT_WEIGHT_PREF } from "../weightPrefs";
import { fetchLatestWeighInDate } from "../lastWeighIn";

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadPrefs: jest.fn(),
  savePrefs: jest.fn(),
}));

jest.mock("../schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));
jest.mock("../customPrefs", () => ({ loadCustom: jest.fn(async () => []) }));
jest.mock("../lastWeighIn", () => ({ fetchLatestWeighInDate: jest.fn() }));

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void };
const mockToastShow = jest.fn<void, [ToastOptions]>();
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

const mockGetPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissions = Notifications.requestPermissionsAsync as jest.Mock;
const mockLoadPrefs = loadPrefs as jest.Mock;
const mockSavePrefs = savePrefs as jest.Mock;
const mockApplyAllReminders = applyAllReminders as jest.Mock;
const mockFetchLatestWeighInDate = fetchLatestWeighInDate as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPrefs.mockResolvedValue(DEFAULT_PREFS);
  mockSavePrefs.mockResolvedValue(undefined);
  mockApplyAllReminders.mockResolvedValue(undefined);
  mockFetchLatestWeighInDate.mockResolvedValue(null);
});

test("denial path: rejecting the permission prompt leaves the slot disabled and skips persistence", async () => {
  mockGetPermissions.mockResolvedValue({ granted: false });
  mockRequestPermissions.mockResolvedValue({ granted: false });

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  // "snack" starts disabled in DEFAULT_PREFS; attempting to enable it is denied.
  await act(async () => {
    result.current.setSlot("snack", { enabled: true, hour: 15, minute: 0 });
  });

  expect(result.current.prefs.snack.enabled).toBe(false);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(mockApplyAllReminders).not.toHaveBeenCalled();
});

test("blocked (canAskAgain false): toggle reverts and toast surfaces the Open Settings action", async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: false });
  mockRequestPermissions.mockResolvedValue({ granted: false, canAskAgain: false });

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  await act(async () => {
    result.current.setSlot("snack", { enabled: true, hour: 15, minute: 0 });
  });

  expect(result.current.prefs.snack.enabled).toBe(false);
  expect(mockToastShow).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Notifications are off for Kora. Turn them on in Settings to get reminders.",
      actionLabel: "Open Settings",
      onAction: expect.any(Function),
    }),
  );
});

test("denied after a fresh prompt: plain toast, no action", async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: false, canAskAgain: true });

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  await act(async () => {
    result.current.setSlot("snack", { enabled: true, hour: 15, minute: 0 });
  });

  expect(mockToastShow).toHaveBeenCalledWith({ message: "Reminders need notification permission." });
});

test("latest-value: two concurrent disables both land in the final persisted prefs (no clobbering)", async () => {
  mockLoadPrefs.mockResolvedValue(DEFAULT_PREFS); // breakfast/lunch/dinner on, snack off

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  // Neither call needs a permission prompt (both disable), so both run concurrently
  // without waiting on each other — this is what would expose a stale-closure race.
  await act(async () => {
    result.current.setSlot("dinner", { enabled: false, hour: 18, minute: 30 });
    result.current.setSlot("lunch", { enabled: false, hour: 12, minute: 30 });
  });

  await waitFor(() => expect(mockSavePrefs).toHaveBeenCalledTimes(2));

  const lastCallPrefs = mockSavePrefs.mock.calls[mockSavePrefs.mock.calls.length - 1][0];
  expect(lastCallPrefs.dinner.enabled).toBe(false);
  expect(lastCallPrefs.lunch.enabled).toBe(false);
  expect(result.current.prefs.dinner.enabled).toBe(false);
  expect(result.current.prefs.lunch.enabled).toBe(false);
});

test("grant path: enabling with permission already granted persists and re-schedules", async () => {
  mockGetPermissions.mockResolvedValue({ granted: true });

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  await act(async () => {
    result.current.setSlot("snack", { enabled: true, hour: 15, minute: 0 });
  });

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(result.current.prefs.snack.enabled).toBe(true);
  expect(mockSavePrefs).toHaveBeenCalledWith(expect.objectContaining({ snack: { enabled: true, hour: 15, minute: 0 } }));
  expect(mockApplyAllReminders).toHaveBeenCalledWith(
    expect.objectContaining({ snack: { enabled: true, hour: 15, minute: 0 } }),
    [],
    expect.objectContaining({ pref: DEFAULT_WEIGHT_PREF, lastWeighedAt: null, now: expect.any(Date) }),
  );
});

// Regression: Task 3 shipped this call site with a placeholder `lastWeighedAt:
// null`, which forgets a real weigh-in the user just logged. Toggling a meal
// slot minutes after weighing in must not un-arm the "already weighed in
// today" skip — that's the reminder's one distinguishing behaviour.
test("toggling a meal slot preserves the fetched last weigh-in date, not null", async () => {
  mockGetPermissions.mockResolvedValue({ granted: true });
  const weighedInAt = new Date(2026, 7, 9, 6, 45);
  mockFetchLatestWeighInDate.mockResolvedValue(weighedInAt);

  const { result } = await renderHook(() => useReminderPrefs());
  await waitFor(() => expect(result.current.ready).toBe(true));

  await act(async () => {
    result.current.setSlot("snack", { enabled: true, hour: 15, minute: 0 });
  });

  expect(mockApplyAllReminders).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: weighedInAt }),
  );
});
