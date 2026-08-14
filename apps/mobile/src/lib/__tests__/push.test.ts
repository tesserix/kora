import { renderHook, waitFor } from "@testing-library/react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged } from "firebase/auth";
import {
  registerPushToken,
  unregisterPushToken,
  setupPushHandler,
  usePushRegistration,
  usePushResponder,
} from "../push";
import { registerDevice, unregisterDevice } from "../pushApi";
import { targetFor } from "../notificationTarget";
import { applyAllReminders, cancelAllReminders } from "@/reminders/schedule";
import { DEFAULT_WEIGHT_PREF } from "@/reminders/weightPrefs";
import { fetchLatestWeighInDate } from "@/reminders/lastWeighIn";
import { resolveAuthState } from "@/lib/authState";

jest.mock("../pushApi", () => ({
  registerDevice: jest.fn(async () => {}),
  unregisterDevice: jest.fn(async () => {}),
}));

// Firebase is initialised elsewhere; a light mock keeps the module import
// clean. Configured (not null) so usePushRegistration's auth subscription is
// actually reachable.
jest.mock("@/lib/firebase", () => ({ auth: { name: "fake-auth" }, isFirebaseConfigured: true }));
// firebase/auth ships ESM that Jest can't transform out of the box; the repo's
// existing tests (e.g. more.test.tsx) mock it directly for the same reason.
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));

jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));

// The auth gate (#171). Reminders and their deep links belong to a signed-in
// user; tests that are not about the gate declare the signed-in case.
jest.mock("@/lib/authState", () => ({ resolveAuthState: jest.fn(async () => "signed-in") }));

// usePushResponder's non-reminder branch only needs targetFor's return value,
// not its real switch logic — mocked here to keep the routing test focused.
jest.mock("../notificationTarget", () => ({ targetFor: jest.fn() }));

// setupPushHandler's reschedule-on-launch isn't under test in this file
// (usePushResponder doesn't call it), but push.ts imports both modules at the
// top level, so they're mocked to keep the import hermetic.
jest.mock("@/reminders/prefs", () => ({ loadPrefs: jest.fn(async () => ({})) }));
jest.mock("@/reminders/schedule", () => ({
  applyAllReminders: jest.fn(async () => {}),
  cancelAllReminders: jest.fn(async () => {}),
}));
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
  (resolveAuthState as jest.Mock).mockResolvedValue("signed-in");
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
// the payload plus the identity (request id + delivery date) it de-duplicates
// on — without pulling in the full (large) expo-notifications
// NotificationResponse type.
//
// The identity defaults to a fresh one per call, so a test that does not
// deliberately re-deliver the SAME response is never accidentally de-duplicated
// by module-level state left behind by an earlier test.
let nextResponseId = 0;
function fakeResponse(
  data: unknown,
  identity?: { identifier: string; date: number },
): Notifications.NotificationResponse {
  const id = identity ?? { identifier: `req-${++nextResponseId}`, date: 1_700_000_000_000 };
  return {
    notification: { date: id.date, request: { identifier: id.identifier, content: { data } } },
  } as unknown as Notifications.NotificationResponse;
}

// listenerFrom renders the hook and hands back the callback expo-notifications
// was given, which is what a real notification tap invokes.
async function listenerFrom(): Promise<(r: Notifications.NotificationResponse) => unknown> {
  await renderHook(() => usePushResponder());
  const calls = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][0];
}

test("reminder tap routes straight to /capture and skips the targetFor deep-link path", async () => {
  const callback = await listenerFrom();

  await callback(fakeResponse({ kind: "reminder", slot: "breakfast" }));

  // replace, not push: repeated delivery of a reminder response must not be
  // able to stack capture screens on top of each other (#171).
  expect(router.replace).toHaveBeenCalledWith("/capture");
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();
  expect(targetFor).not.toHaveBeenCalled();
});

test("tapping a custom reminder routes to Home", async () => {
  const callback = await listenerFrom();

  await callback(fakeResponse({ kind: "custom", id: "cr_1" }));

  expect(router.replace).toHaveBeenCalledWith("/");
  expect(router.replace).toHaveBeenCalledTimes(1);
});

// Regression: the weight reminder's payload is { kind: "weight" }, which had no
// branch here. It fell through to the targetFor path, which has no "weight"
// case either, so tapping the notification opened the app wherever it last was
// — no deep link at all. Weight logging lives in WeightLogSheet on Progress.
test("tapping a weight check-in reminder routes to Progress, where weight is logged", async () => {
  const callback = await listenerFrom();

  await callback(fakeResponse({ kind: "weight" }));

  expect(router.replace).toHaveBeenCalledWith("/progress");
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(targetFor).not.toHaveBeenCalled();
});

test("non-reminder tap still routes via the existing targetFor deep-link path, not /capture", async () => {
  (targetFor as jest.Mock).mockReturnValue("/friends");
  const callback = await listenerFrom();

  await callback(fakeResponse({ type: "friend_request", entity_id: "x" }));

  expect(targetFor).toHaveBeenCalledWith({ type: "friend_request", entity_id: "x" });
  expect(router.replace).toHaveBeenCalledWith("/friends");
  expect(router.replace).not.toHaveBeenCalledWith("/capture");
});

// --- the signed-out deep link, and the stacking it caused (#171) -----------
//
// Reported from a real device: after deleting their account and sitting on the
// sign-in screen, a "log dinner" reminder fired and opened the CAPTURE screen
// while signed out. usePushResponder() is called at the top of TabsLayout,
// before the onAuthStateChanged -> /sign-in redirect in its effect has run, so
// the listener is live during the signed-out moments of a launch.
test("a reminder tap while signed out navigates nowhere", async () => {
  (resolveAuthState as jest.Mock).mockResolvedValue("signed-out");
  const callback = await listenerFrom();

  await callback(fakeResponse({ kind: "reminder", slot: "dinner" }));

  expect(router.replace).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

test("no deep link of any kind opens while signed out", async () => {
  (resolveAuthState as jest.Mock).mockResolvedValue("signed-out");
  (targetFor as jest.Mock).mockReturnValue("/friends");
  const callback = await listenerFrom();

  await callback(fakeResponse({ kind: "custom", id: "cr_1" }));
  await callback(fakeResponse({ kind: "weight" }));
  await callback(fakeResponse({ type: "friend_request", entity_id: "x" }));

  expect(router.replace).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

// The stacking. The device report needed capture closed 3-4 times before it
// stopped. TabsLayout remounts re-register the listener, and expo-notifications
// re-delivers the pending launch response to each newly added listener, so ONE
// tap produced several navigations. This asserts the observable consequence:
// the same response delivered repeatedly navigates exactly once.
test("the same notification response delivered repeatedly navigates exactly once", async () => {
  const identity = { identifier: "req-stack", date: 1_700_000_000_000 };
  const callback = await listenerFrom();
  const second = await listenerFrom();

  await callback(fakeResponse({ kind: "reminder", slot: "dinner" }, identity));
  await second(fakeResponse({ kind: "reminder", slot: "dinner" }, identity));
  await callback(fakeResponse({ kind: "reminder", slot: "dinner" }, identity));

  expect(router.replace).toHaveBeenCalledTimes(1);
});

// The de-duplication keys on the DELIVERY, not on the scheduled request: a
// DAILY trigger keeps the same request identifier for every occurrence, so
// keying on the identifier alone would silently kill tomorrow's deep link.
test("the next occurrence of the same daily reminder still deep-links", async () => {
  const callback = await listenerFrom();

  await callback(
    fakeResponse({ kind: "reminder", slot: "dinner" }, { identifier: "daily-dinner", date: 1 }),
  );
  await callback(
    fakeResponse({ kind: "reminder", slot: "dinner" }, { identifier: "daily-dinner", date: 2 }),
  );

  expect(router.replace).toHaveBeenCalledTimes(2);
});

// The listener is removed on unmount; leaking one per TabsLayout remount is
// what multiplied the deliveries in the first place.
test("the listener is removed when the responder unmounts", async () => {
  const remove = jest.fn();
  (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockReturnValue({ remove });

  const { unmount } = await renderHook(() => usePushResponder());
  await unmount();

  expect(remove).toHaveBeenCalledTimes(1);
});

// --- the launch re-arm gate (#171) ----------------------------------------

test("setupPushHandler does NOT re-arm reminders while signed out", async () => {
  (resolveAuthState as jest.Mock).mockResolvedValue("signed-out");

  setupPushHandler();

  await waitFor(() => expect(cancelAllReminders).toHaveBeenCalled());
  expect(applyAllReminders).not.toHaveBeenCalled();
});


// --- re-arming on sign-in (#171) ------------------------------------------
//
// The launch pass is now gated on a signed-in user, so a launch that lands on
// the sign-in screen deliberately arms nothing. Something must therefore re-arm
// when the user actually signs in, or their reminders stay dead for the rest of
// the session (until the next foreground pass).
test("signing in re-arms the reminders the signed-out launch declined to arm", async () => {
  await renderHook(() => usePushRegistration());
  const onAuth = (onAuthStateChanged as jest.Mock).mock.calls[0][1];

  onAuth({ uid: "u1" });

  await waitFor(() => expect(applyAllReminders).toHaveBeenCalled());
});

test("an auth callback with no user arms nothing", async () => {
  (resolveAuthState as jest.Mock).mockResolvedValue("signed-out");
  await renderHook(() => usePushRegistration());
  const onAuth = (onAuthStateChanged as jest.Mock).mock.calls[0][1];

  onAuth(null);

  await waitFor(() => expect(registerDevice).not.toHaveBeenCalled());
  expect(applyAllReminders).not.toHaveBeenCalled();
});
