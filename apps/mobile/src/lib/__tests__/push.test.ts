import { renderHook, waitFor } from "@testing-library/react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerPushToken, unregisterPushToken, setupPushHandler, usePushResponder } from "../push";
import { registerDevice, unregisterDevice } from "../pushApi";
import { targetFor } from "../notificationTarget";
import { applyAllReminders } from "@/reminders/schedule";
import { DEFAULT_WEIGHT_PREF } from "@/reminders/weightPrefs";
import { fetchLatestWeighInDate } from "@/reminders/lastWeighIn";

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
jest.mock("@/reminders/weightPrefs", () => {
  const actual = jest.requireActual("@/reminders/weightPrefs");
  return { ...actual, loadWeightPref: jest.fn(async () => actual.DEFAULT_WEIGHT_PREF) };
});
jest.mock("@/reminders/lastWeighIn", () => ({ fetchLatestWeighInDate: jest.fn(async () => null) }));

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

// Regression: after `eas init` supplied a projectId, this code path went live
// and getExpoPushTokenAsync started rejecting wherever no push service exists
// (every simulator, or an offline device). The floating `void registerPushToken()`
// in usePushRegistration had no catch, so it surfaced as a red LogBox error on
// every launch — sitting on top of the footer's primary button.
test("registerPushToken resolves instead of rejecting when the push service is unreachable", async () => {
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValueOnce(
    new Error("fetch failed: UnexpectedException: A server with the specified hostname could not be found."),
  );
  await expect(registerPushToken()).resolves.toBeUndefined();
  expect(registerDevice).not.toHaveBeenCalled();
});

// The permission lookup itself can throw (a wedged notification service). A
// partial fix that only guarded the token fetch would leave the same crash
// reachable one line earlier.
test("registerPushToken resolves instead of rejecting when the permission lookup throws", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error("notification service unavailable"));
  await expect(registerPushToken()).resolves.toBeUndefined();
  expect(registerDevice).not.toHaveBeenCalled();
});

// Registering the device is a best-effort side effect too: a 500 from the API
// must not reach the user as a crash on an otherwise successful sign-in.
test("registerPushToken resolves instead of rejecting when the API refuses the registration", async () => {
  (registerDevice as jest.Mock).mockRejectedValueOnce(new Error("500 internal_error"));
  await expect(registerPushToken()).resolves.toBeUndefined();
});

// Regression: setupPushHandler runs on every app launch and re-syncs the whole
// OS notification schedule via applyAllReminders, which starts by cancelling
// every pending notification. If this call site omitted the weight argument
// (as it briefly did), a user's weight reminder would be silently destroyed on
// the next launch and never rescheduled. Asserting call count alone would not
// catch a missing/wrong third argument, so this asserts the actual argument.
//
// Re-specced: this used to assert `lastWeighedAt: null`, which cemented a bug.
// The launch pass hard-coded "I don't know" as "never weighed in", so weighing
// in at 06:40 and merely reopening the app at 06:50 re-armed the 07:00
// reminder — exactly the nag the feature exists to prevent. The launch pass
// must consult the REAL last weigh-in, so the assertion now pins the fetched
// date reaching the scheduler.
test("setupPushHandler re-syncs reminders on every launch using the real last weigh-in, not a null placeholder", async () => {
  const alreadyWeighedToday = new Date(2026, 7, 17, 6, 40);
  (fetchLatestWeighInDate as jest.Mock).mockResolvedValue(alreadyWeighedToday);

  setupPushHandler();

  await waitFor(() =>
    expect(applyAllReminders).toHaveBeenCalledWith(
      {},
      [],
      expect.objectContaining({
        pref: DEFAULT_WEIGHT_PREF,
        lastWeighedAt: alreadyWeighedToday,
        now: expect.any(Date),
      }),
    ),
  );
});

// The invariant the old assertion was really protecting: a failed lookup must
// resolve to null so the reminder still FIRES. Ignorance never suppresses.
test("setupPushHandler still arms the reminder when the last weigh-in cannot be fetched", async () => {
  (fetchLatestWeighInDate as jest.Mock).mockResolvedValue(null);

  setupPushHandler();

  await waitFor(() =>
    expect(applyAllReminders).toHaveBeenCalledWith(
      {},
      [],
      expect.objectContaining({ pref: DEFAULT_WEIGHT_PREF, lastWeighedAt: null, now: expect.any(Date) }),
    ),
  );
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

// Regression: the weight reminder's payload is { kind: "weight" }, which had no
// branch here. It fell through to the targetFor path, which has no "weight"
// case either, so tapping the notification opened the app wherever it last was
// — no deep link at all. Weight logging lives in WeightLogSheet on Progress.
test("tapping a weight check-in reminder routes to Progress, where weight is logged", async () => {
  await renderHook(() => usePushResponder());
  const callback = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];

  callback(fakeResponse({ kind: "weight" }));

  expect(router.push).toHaveBeenCalledWith("/progress");
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(targetFor).not.toHaveBeenCalled();
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
