import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const mockVault = new Map<string, string>();
let mockStorage: typeof AsyncStorage;

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async (key: string) => mockVault.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockVault.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockVault.delete(key); }),
}), { virtual: true });
jest.mock("firebase/app", () => ({ initializeApp: jest.fn() }));
jest.mock("firebase/auth", () => ({
  initializeAuth: jest.fn(),
  getReactNativePersistence: (storage: typeof AsyncStorage) => { mockStorage = storage; return {}; },
}));
jest.mock("../firebaseConfig", () => ({ readFirebaseConfig: () => ({ apiKey: "fixture" }) }));

beforeAll(() => { require("../firebase"); });
beforeEach(async () => {
  mockVault.clear();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

test("persists Firebase sessions without writing plaintext credentials", async () => {
  const key = "firebase:authUser:fixture:[DEFAULT]";
  const value = JSON.stringify({ refreshToken: "fixture-refresh", uid: "alice" });
  await mockStorage.setItem(key, value);
  expect(await mockStorage.getItem(key)).toBe(value);
  expect(await AsyncStorage.getItem(key)).toBeNull();
  expect([...mockVault.values()]).toContain(value);
});

test("migrates the existing session and removes the plaintext copy", async () => {
  const key = "firebase:authUser:fixture:[DEFAULT]";
  await AsyncStorage.setItem(key, "legacy-session");
  expect(await mockStorage.getItem(key)).toBe("legacy-session");
  expect(await AsyncStorage.getItem(key)).toBeNull();
  expect([...mockVault.values()]).toContain("legacy-session");
});

test("never falls back to plaintext when secure storage rejects a write", async () => {
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  await expect(mockStorage.setItem("session", "fixture")).rejects.toThrow("locked");
  expect(await AsyncStorage.getItem("session")).toBeNull();
});

test("removes both copies on sign-out without resurrecting the old session", async () => {
  await mockStorage.setItem("session", "current");
  await AsyncStorage.setItem("session", "legacy");
  await mockStorage.removeItem("session");
  expect(await mockStorage.getItem("session")).toBeNull();
  expect(mockVault.size).toBe(0);
});

test("keeps distinct Firebase keys separate with valid vault key characters", async () => {
  await mockStorage.setItem("firebase:a:b", "alice");
  await mockStorage.setItem("firebase:a_b", "bob");
  expect(await mockStorage.getItem("firebase:a:b")).toBe("alice");
  expect(await mockStorage.getItem("firebase:a_b")).toBe("bob");
  for (const key of mockVault.keys()) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
});
