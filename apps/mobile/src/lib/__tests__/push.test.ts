import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerPushToken, unregisterPushToken } from "../push";
import { registerDevice, unregisterDevice } from "../pushApi";

jest.mock("../pushApi", () => ({
  registerDevice: jest.fn(async () => {}),
  unregisterDevice: jest.fn(async () => {}),
}));

// Firebase is initialised elsewhere; the exported functions under test don't
// touch it, so a light mock keeps the module import clean.
jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));
// firebase/auth ships ESM that Jest can't transform out of the box; the repo's
// existing tests (e.g. more.test.tsx) mock it directly for the same reason.
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));

function setProjectId(id: string | undefined): void {
  (Constants as unknown as { expoConfig: { extra: { eas: { projectId: string | undefined } } } }).expoConfig = {
    extra: { eas: { projectId: id } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setProjectId("test-project");
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted" });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted" });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: "ExponentPushToken[abc]" });
});

test("registerPushToken is a no-op when projectId is absent (inert until eas init)", async () => {
  setProjectId(undefined);
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registerDevice).not.toHaveBeenCalled();
});

test("registerPushToken is a no-op when permission is denied", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied" });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied" });
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registerDevice).not.toHaveBeenCalled();
});

test("registerPushToken registers the token and caches it on the happy path", async () => {
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "test-project" });
  expect(registerDevice).toHaveBeenCalledWith("ExponentPushToken[abc]", expect.any(String));
  expect(await AsyncStorage.getItem("kora.pushToken")).toBe("ExponentPushToken[abc]");
});

test("unregisterPushToken deletes and clears the cached token", async () => {
  await AsyncStorage.setItem("kora.pushToken", "ExponentPushToken[abc]");
  await unregisterPushToken();
  expect(unregisterDevice).toHaveBeenCalledWith("ExponentPushToken[abc]");
  expect(await AsyncStorage.getItem("kora.pushToken")).toBeNull();
});
