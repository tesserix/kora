import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useCustomReminders } from "../useCustomReminders";
import { loadCustom, saveCustom, MAX_CUSTOM_REMINDERS, type CustomReminder } from "../customPrefs";
import { applyAllReminders } from "../schedule";

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));
jest.mock("../customPrefs", () => {
  const actual = jest.requireActual("../customPrefs");
  return { ...actual, loadCustom: jest.fn(async () => []), saveCustom: jest.fn(async () => {}) };
});
jest.mock("../prefs", () => ({ loadPrefs: jest.fn(async () => ({})) }));
jest.mock("../schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));

const mockLoad = loadCustom as jest.Mock;
const mockSave = saveCustom as jest.Mock;
const mockApply = applyAllReminders as jest.Mock;
const draft = { label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] as CustomReminder["days"], enabled: true };

beforeEach(() => {
  jest.clearAllMocks();
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  mockLoad.mockResolvedValue([]);
});

test("addReminder persists + re-syncs, assigning an id", async () => {
  const { result } = await renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.addReminder(draft); });
  expect(mockSave).toHaveBeenCalledTimes(1);
  const saved = mockSave.mock.calls[0][0] as CustomReminder[];
  expect(saved).toHaveLength(1);
  expect(saved[0].id.length).toBeGreaterThan(0);
  expect(saved[0].label).toBe("Drink water");
  expect(mockApply).toHaveBeenCalledWith({}, saved);
});

test("addReminder is a no-op at the cap", async () => {
  mockLoad.mockResolvedValue(
    Array.from({ length: MAX_CUSTOM_REMINDERS }, (_, i) => ({ id: `id${i}`, label: `r${i}`, hour: 9, minute: 0, days: [1], enabled: true })),
  );
  const { result } = await renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(MAX_CUSTOM_REMINDERS));
  await act(async () => { await result.current.addReminder(draft); });
  expect(mockSave).not.toHaveBeenCalled();
});

test("toggleReminder off does not require permission and persists", async () => {
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: true }]);
  const { result } = await renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.toggleReminder("a", false); });
  expect((mockSave.mock.calls[0][0] as CustomReminder[])[0].enabled).toBe(false);
});

test("enabling with permission denied does not persist", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: false }]);
  const { result } = await renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.toggleReminder("a", true); });
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

test("removeReminder drops it and re-syncs", async () => {
  mockLoad.mockResolvedValue([{ id: "a", label: "x", hour: 9, minute: 0, days: [1], enabled: true }]);
  const { result } = await renderHook(() => useCustomReminders());
  await waitFor(() => expect(result.current.reminders).toHaveLength(1));
  await act(async () => { await result.current.removeReminder("a"); });
  expect(mockSave).toHaveBeenCalledWith([]);
  expect(mockApply).toHaveBeenCalledWith({}, []);
});
