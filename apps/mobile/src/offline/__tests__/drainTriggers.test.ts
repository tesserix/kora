import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient } from "@tanstack/react-query";
import { onAuthStateChanged } from "firebase/auth";
import { apiFetch, isAuthenticated } from "@/lib/api";
import { append, list } from "../queue";
import { installDrainTriggers } from "../drainTriggers";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  isAuthenticated: jest.fn(() => true),
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
async function eventually(check: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await check(); return; } catch { await new Promise((r) => setTimeout(r, 5)); }
  }
  await check();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  (isAuthenticated as jest.Mock).mockReturnValue(true);
});

// The cold-start drain almost always loses the race against Firebase restoring
// the session, so without a sign-in trigger a queue built up offline would sit
// there until the user happened to background and foreground the app.
test("a queued log drains when sign-in completes, not on the signed-out cold start", async () => {
  (isAuthenticated as jest.Mock).mockReturnValue(false);
  (apiFetch as jest.Mock).mockResolvedValue({});
  await append(payload, "id-1");

  const uninstall = installDrainTriggers(new QueryClient());
  await new Promise((r) => setTimeout(r, 10));
  expect(apiFetch).not.toHaveBeenCalled();
  expect(await list()).toHaveLength(1);

  // The sign-in trigger must exist; without it nothing below could ever fire.
  const authCalls = (onAuthStateChanged as jest.Mock).mock.calls;
  expect(authCalls).toHaveLength(1);

  // Firebase restores the session.
  (isAuthenticated as jest.Mock).mockReturnValue(true);
  authCalls[0][1]({ uid: "u1" });

  await eventually(async () => {
    expect(apiFetch).toHaveBeenCalledWith("/v1/logs", expect.objectContaining({ method: "POST" }));
    expect(await list()).toHaveLength(0);
  });

  uninstall();
});

test("uninstall detaches the sign-in listener", () => {
  const unsubscribe = jest.fn();
  (onAuthStateChanged as jest.Mock).mockReturnValueOnce(unsubscribe);

  installDrainTriggers(new QueryClient())();

  expect(unsubscribe).toHaveBeenCalled();
});
