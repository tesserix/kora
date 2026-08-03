import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { onAuthStateChanged } from "firebase/auth";
import { apiFetch, currentUserId } from "@/lib/api";
import { append, list } from "../queue";
import { resolveOwnerId } from "../owner";
import { installDrainTriggers } from "../drainTriggers";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  ApiError: class ApiError extends Error {},
}));

jest.mock("@/lib/firebase", () => ({ auth: { name: "test-auth" }, isFirebaseConfigured: true }));

jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

// A tiny poller: the triggers fire drains fire-and-forget, so there is no
// promise to await. Nothing here is React, so RNTL's waitFor would only add an
// act() environment this test does not need.
async function eventually(check: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await check(); return; } catch { await new Promise((r) => setTimeout(r, 5)); }
  }
  await check();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  (currentUserId as jest.Mock).mockReturnValue("user-a");
});

// The cold-start drain almost always loses the race against Firebase restoring
// the session, so without a sign-in trigger a queue built up offline would sit
// there until the user happened to background and foreground the app.
test("a queued log drains when sign-in completes, not on the signed-out cold start", async () => {
  (currentUserId as jest.Mock).mockReturnValue(null);
  (apiFetch as jest.Mock).mockResolvedValue({});
  await append(payload, "id-1", "user-a");

  const uninstall = installDrainTriggers(new QueryClient());
  await new Promise((r) => setTimeout(r, 10));
  expect(apiFetch).not.toHaveBeenCalled();
  expect(await list()).toHaveLength(1);

  // The sign-in trigger must exist; without it nothing below could ever fire.
  const authCalls = (onAuthStateChanged as jest.Mock).mock.calls;
  expect(authCalls).toHaveLength(1);

  // Firebase restores the session.
  (currentUserId as jest.Mock).mockReturnValue("user-a");
  authCalls[0][1]({ uid: "u1" });

  await eventually(async () => {
    expect(apiFetch).toHaveBeenCalledWith("/v1/logs", expect.objectContaining({ method: "POST" }));
    expect(await list()).toHaveLength(0);
  });

  uninstall();
});

// The fallback in owner.ts is only worth anything if something records the uid.
// Sign-in is the one moment the app reliably learns it, so a write during the
// NEXT launch's restore window can be attributed to the right account.
test("sign-in records the uid so the next launch can attribute writes", async () => {
  (currentUserId as jest.Mock).mockReturnValue(null);
  expect(await resolveOwnerId()).toBeNull();

  const uninstall = installDrainTriggers(new QueryClient());
  (onAuthStateChanged as jest.Mock).mock.calls[0][1]({ uid: "user-b" });

  await eventually(async () => expect(await resolveOwnerId()).toBe("user-b"));
  uninstall();
});

// All three listeners, not just one: a teardown that forgets any of them leaks
// a subscription per mount, and every leaked one keeps firing drains for a
// query client the app has moved on from.
test("uninstall detaches every listener it installed", async () => {
  // Signed out, so the synchronous cold-start drain this install fires is a
  // no-op and cannot land after the test ends.
  (currentUserId as jest.Mock).mockReturnValue(null);

  const unsubscribeAuth = jest.fn();
  const unsubscribeOnline = jest.fn();
  const removeAppState = jest.fn();
  (onAuthStateChanged as jest.Mock).mockReturnValueOnce(unsubscribeAuth);
  const onlineSpy = jest.spyOn(onlineManager, "subscribe").mockReturnValue(unsubscribeOnline);
  const appStateSpy = jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: removeAppState } as ReturnType<typeof AppState.addEventListener>);

  try {
    installDrainTriggers(new QueryClient())();

    expect(unsubscribeAuth).toHaveBeenCalled();
    expect(unsubscribeOnline).toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalled();
  } finally {
    onlineSpy.mockRestore();
    appStateSpy.mockRestore();
  }

  // Settle the cold-start drain's promise before the test ends.
  await new Promise((r) => setTimeout(r, 0));
  expect(apiFetch).not.toHaveBeenCalled();
});
