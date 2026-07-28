import { renderHook } from "@testing-library/react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerPushToken, unregisterPushToken, usePushResponder } from "../push";
import { registerDevice, unregisterDevice } from "../pushApi";
import { targetFor } from "../notificationTarget";

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

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

// usePushResponder's non-reminder branch only needs targetFor's return value,
// not its real switch logic — mocked here to keep the routing test focused.
jest.mock("../notificationTarget", () => ({ targetFor: jest.fn() }));

// setupPushHandler's reschedule-on-launch isn't under test in this file
// (usePushResponder doesn't call it), but push.ts imports both modules at the
// top level, so they're mocked to keep the import hermetic.
jest.mock("@/reminders/prefs", () => ({ loadPrefs: jest.fn(async () => ({})) }));
jest.mock("@/reminders/schedule", () => ({ applyAllReminders: jest.fn(async () => {}) }));
jest.mock("@/reminders/customPrefs", () => ({ loadCustom: jest.fn(async () => []) }));

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

// fakeResponse builds the minimal shape usePushResponder's listener reads —
// response.notification.request.content.data — without pulling in the full
// (large) expo-notifications NotificationResponse type.
function fakeResponse(data: unknown): Notifications.NotificationResponse {
  return {
    notification: { request: { content: { data } } },
  } as unknown as Notifications.NotificationResponse;
}

test("reminder tap routes straight to /capture and skips the targetFor deep-link path", async () => {
  await renderHook(() => usePushResponder());
  const callback = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];

  callback(fakeResponse({ kind: "reminder", slot: "breakfast" }));

  expect(router.push).toHaveBeenCalledWith("/capture");
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(targetFor).not.toHaveBeenCalled();
});

test("tapping a custom reminder routes to Home", async () => {
  await renderHook(() => usePushResponder());
  const callback = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];

  callback(fakeResponse({ kind: "custom", id: "cr_1" }));

  expect(router.push).toHaveBeenCalledWith("/");
  expect(router.push).toHaveBeenCalledTimes(1);
});

test("non-reminder tap still routes via the existing targetFor deep-link path, not /capture", async () => {
  (targetFor as jest.Mock).mockReturnValue("/friends");
  await renderHook(() => usePushResponder());
  const callback = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];

  callback(fakeResponse({ type: "friend_request", entity_id: "x" }));

  expect(targetFor).toHaveBeenCalledWith({ type: "friend_request", entity_id: "x" });
  expect(router.push).toHaveBeenCalledWith("/friends");
  expect(router.push).not.toHaveBeenCalledWith("/capture");
});
