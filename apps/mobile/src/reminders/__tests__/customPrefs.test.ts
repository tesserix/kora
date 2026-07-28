import { loadCustom, saveCustom, newId, MAX_CUSTOM_REMINDERS, type CustomReminder } from "../customPrefs";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockGet = AsyncStorage.getItem as jest.Mock;
const mockSet = AsyncStorage.setItem as jest.Mock;

const valid: CustomReminder = { id: "a", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true };

beforeEach(() => { mockGet.mockReset(); mockSet.mockReset(); });

test("loadCustom returns [] when nothing stored", async () => {
  mockGet.mockResolvedValueOnce(null);
  expect(await loadCustom()).toEqual([]);
});

test("loadCustom returns [] (no throw) when stored value is corrupt", async () => {
  mockGet.mockResolvedValueOnce("{not json");
  expect(await loadCustom()).toEqual([]);
});

test("loadCustom drops malformed entries", async () => {
  mockGet.mockResolvedValueOnce(JSON.stringify([
    valid,
    { id: "b", label: "", hour: 8, minute: 0, days: [1], enabled: true }, // empty label
    { id: "c", label: "x", hour: 8, minute: 0, days: [], enabled: true },  // empty days
    { id: "d", label: "y", hour: 99, minute: 0, days: [1], enabled: true }, // bad hour
  ]));
  expect(await loadCustom()).toEqual([valid]);
});

test("saveCustom writes JSON under the custom key", async () => {
  await saveCustom([valid]);
  expect(mockSet).toHaveBeenCalledWith("kora.customReminders", JSON.stringify([valid]));
});

test("newId returns a non-empty unique-ish string", () => {
  const a = newId();
  expect(typeof a).toBe("string");
  expect(a.length).toBeGreaterThan(0);
});

test("MAX_CUSTOM_REMINDERS is 20", () => {
  expect(MAX_CUSTOM_REMINDERS).toBe(20);
});
