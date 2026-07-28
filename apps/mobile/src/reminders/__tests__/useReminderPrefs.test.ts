import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useReminderPrefs } from "../useReminderPrefs";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../prefs";
import { applyAllReminders } from "../schedule";

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

const mockGetPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissions = Notifications.requestPermissionsAsync as jest.Mock;
const mockLoadPrefs = loadPrefs as jest.Mock;
const mockSavePrefs = savePrefs as jest.Mock;
const mockApplyAllReminders = applyAllReminders as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPrefs.mockResolvedValue(DEFAULT_PREFS);
  mockSavePrefs.mockResolvedValue(undefined);
  mockApplyAllReminders.mockResolvedValue(undefined);
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
  expect(mockApplyAllReminders).toHaveBeenCalledWith(expect.objectContaining({ snack: { enabled: true, hour: 15, minute: 0 } }), []);
});
