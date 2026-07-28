import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../prefs";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockGet = AsyncStorage.getItem as jest.Mock;
const mockSet = AsyncStorage.setItem as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
});

test("loadPrefs returns defaults when nothing stored", async () => {
  mockGet.mockResolvedValueOnce(null);
  expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
});

test("loadPrefs returns defaults (no throw) when stored value is corrupt", async () => {
  mockGet.mockResolvedValueOnce("{not json");
  expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
});

test("savePrefs then loadPrefs round-trips", async () => {
  const prefs = { ...DEFAULT_PREFS, lunch: { enabled: false, hour: 13, minute: 15 } };
  await savePrefs(prefs);
  expect(mockSet).toHaveBeenCalledWith("kora.reminderPrefs", JSON.stringify(prefs));
  mockGet.mockResolvedValueOnce(JSON.stringify(prefs));
  expect(await loadPrefs()).toEqual(prefs);
});
