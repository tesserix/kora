import { Platform } from "expo-modules-core";

import { clearSnapshot, openNotificationSettings, setSnapshot } from "../../../modules/widget-bridge";

const mockSetSnapshot = jest.fn();
const mockClearSnapshot = jest.fn();
const mockOpenNotificationSettings = jest.fn();
let mockThrows = false;

// Faking the WHOLE "expo-modules-core" module (as a first draft of this test
// did) breaks jest-expo's setup: its lazy global.fetch installer requires
// expo-modules-core's real requireNativeModule('ExpoFetchModule') the first
// time anything touches fetch, and a blanket fake throws for every module
// name, not just "WidgetBridge". See LinkAccountPrompt.android.test.tsx for
// the same root cause with Platform. The fix here is the same shape: keep the
// real module via requireActual and fake only requireNativeModule, falling
// through to the real implementation for any name but "WidgetBridge".
jest.mock("expo-modules-core", () => {
  const actual = jest.requireActual("expo-modules-core");
  return {
    ...actual,
    requireNativeModule: (name: string) => {
      if (name !== "WidgetBridge") return actual.requireNativeModule(name);
      if (mockThrows) throw new Error("native module not linked");
      return {
        setSnapshot: mockSetSnapshot,
        clearSnapshot: mockClearSnapshot,
        openNotificationSettings: mockOpenNotificationSettings,
      };
    },
  };
});

const originalOS = Platform.OS;

beforeEach(() => {
  mockSetSnapshot.mockClear();
  mockClearSnapshot.mockClear();
  mockOpenNotificationSettings.mockClear();
  Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
  mockThrows = false;
});

afterAll(() => {
  Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
});

test("setSnapshot forwards the json to the native module", () => {
  setSnapshot('{"date":"2026-08-11"}');
  expect(mockSetSnapshot).toHaveBeenCalledWith('{"date":"2026-08-11"}');
});

test("clearSnapshot calls through to the native module", () => {
  clearSnapshot();
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});

test("is a no-op on android rather than throwing", () => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  expect(() => setSnapshot("{}")).not.toThrow();
  expect(mockSetSnapshot).not.toHaveBeenCalled();
});

// A dev client built before this module existed has no native side. Throwing
// at call time would take down whichever screen triggered the write.
test("is a no-op when the native module is missing", () => {
  mockThrows = true;
  expect(() => setSnapshot("{}")).not.toThrow();
  expect(() => clearSnapshot()).not.toThrow();
});

test("openNotificationSettings forwards to the native module and returns its result", async () => {
  mockOpenNotificationSettings.mockResolvedValue(true);
  await expect(openNotificationSettings()).resolves.toBe(true);
  expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1);
});

test("openNotificationSettings resolves false on android rather than throwing", async () => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  await expect(openNotificationSettings()).resolves.toBe(false);
  expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
});

// A dev client built before this method existed has the module but not the
// method — calling it throws, and the caller falls back to Linking.openSettings.
test("openNotificationSettings resolves false when the native module is missing or the call throws", async () => {
  mockThrows = true;
  await expect(openNotificationSettings()).resolves.toBe(false);

  mockThrows = false;
  mockOpenNotificationSettings.mockRejectedValue(new Error("method not linked"));
  await expect(openNotificationSettings()).resolves.toBe(false);
});
