// Covers api.ts's 401 recovery: retry-once-with-a-fresh-token, sign-out only
// when the retry also fails, idempotent sign-out under a concurrent burst,
// and that non-401 failures (500, 403) and the no-signed-in-user case never
// trigger either the retry or the sign-out.
//
// Each test gets a fresh copy of api.ts via jest.resetModules() + require()
// so the module-level `hasSignedOutForExpiredSession` flag always starts
// false — the flag is intentionally not test-visible (no exported reset),
// so full module isolation is how tests get a clean slate instead.

const mockSignOut = jest.fn(async (..._args: unknown[]) => {});
const mockOnAuthStateChanged = jest.fn((..._args: unknown[]) => jest.fn());

jest.mock("firebase/auth", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
  onAuthStateChanged: (...args: unknown[]) => mockOnAuthStateChanged(...args),
}));

function mockUser(getIdToken: jest.Mock): { currentUser: { getIdToken: jest.Mock } } {
  return { currentUser: { getIdToken } };
}

let api: typeof import("../api");

function loadApiWithAuth(auth: unknown): void {
  jest.doMock("../firebase", () => ({ auth }));
  jest.isolateModules(() => {
    api = require("../api");
  });
}

beforeEach(() => {
  jest.resetModules();
  mockSignOut.mockClear();
  mockOnAuthStateChanged.mockClear();
  global.fetch = jest.fn();
});

function jsonResponse(status: number, ok: boolean, body: unknown): Partial<Response> {
  return { ok, status, json: async () => body };
}

test("a 401 followed by a successful retry returns data and does not sign out", async () => {
  const getIdToken = jest
    .fn()
    .mockResolvedValueOnce("stale-token")
    .mockResolvedValueOnce("fresh-token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(jsonResponse(401, false, { error: "unauthorized", message: "expired" }))
    .mockResolvedValueOnce(jsonResponse(200, true, { data: { ok: true } }));

  await expect(api.apiFetch("/v1/today")).resolves.toEqual({ ok: true });

  expect(getIdToken).toHaveBeenNthCalledWith(1);
  expect(getIdToken).toHaveBeenNthCalledWith(2, true);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("a 401 that repeats on retry calls signOut exactly once", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "expired" }),
  );

  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 401 });

  expect(getIdToken).toHaveBeenNthCalledWith(2, true);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});

test("a burst of concurrent 401s calls signOut exactly once, not once per request", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "expired" }),
  );

  const results = await Promise.allSettled([
    api.apiFetch("/v1/today"),
    api.apiFetch("/v1/streak"),
    api.apiFetch("/v1/profile"),
    api.apiFetch("/v1/notifications/unread-count"),
  ]);

  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});

test("a 500 does not sign out and still throws ApiError with status 500", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(500, false, { error: "internal", message: "boom" }),
  );

  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 500 });

  // No retry attempted for a non-401 failure — getIdToken(true) never called.
  expect(getIdToken).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("a 403 does not sign out", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(403, false, { error: "forbidden", message: "not allowed" }),
  );

  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 403 });

  expect(getIdToken).toHaveBeenCalledTimes(1);
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("with no signed-in user, neither retry nor signOut is attempted on a 401", async () => {
  loadApiWithAuth({ currentUser: null });

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "no token" }),
  );

  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 401 });

  // Only the single, tokenless request — no forced-refresh retry.
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("apiFetchMultipart gets the same 401 treatment: retry then sign out once", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "expired" }),
  );

  const form = new FormData();
  form.append("file", { uri: "file:///x.jpg", name: "x.jpg", type: "image/jpeg" } as unknown as Blob);

  await expect(api.apiFetchMultipart("/v1/resolve/photo", form)).rejects.toMatchObject({ status: 401 });

  expect(getIdToken).toHaveBeenNthCalledWith(2, true);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});

test("apiFetchMultipart retries and succeeds on refresh without signing out", async () => {
  const getIdToken = jest
    .fn()
    .mockResolvedValueOnce("stale-token")
    .mockResolvedValueOnce("fresh-token");
  loadApiWithAuth(mockUser(getIdToken));

  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(jsonResponse(401, false, { error: "unauthorized", message: "expired" }))
    .mockResolvedValueOnce(jsonResponse(200, true, { data: { tier: "auto" } }));

  const form = new FormData();
  form.append("file", { uri: "file:///x.jpg", name: "x.jpg", type: "image/jpeg" } as unknown as Blob);

  await expect(api.apiFetchMultipart("/v1/resolve/photo", form)).resolves.toEqual({ tier: "auto" });
  expect(mockSignOut).not.toHaveBeenCalled();
});

test("takeSessionExpiredNotice is true after a forced sign-out and false otherwise", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  loadApiWithAuth(mockUser(getIdToken));

  expect(api.takeSessionExpiredNotice()).toBe(false);

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "expired" }),
  );
  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 401 });

  expect(api.takeSessionExpiredNotice()).toBe(true);
  // One-shot: consumed on the first read.
  expect(api.takeSessionExpiredNotice()).toBe(false);
});

test("signing back in resets the sign-out guard for a later session", async () => {
  const getIdToken = jest.fn().mockResolvedValue("token");
  const auth = mockUser(getIdToken);
  loadApiWithAuth(auth);

  // Capture the onAuthStateChanged callback api.ts registered at load time.
  const authStateCallback = mockOnAuthStateChanged.mock.calls[0][1] as (user: unknown) => void;

  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(401, false, { error: "unauthorized", message: "expired" }),
  );
  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 401 });
  expect(mockSignOut).toHaveBeenCalledTimes(1);

  // Session two: user signs back in, then hits another unrecoverable 401.
  authStateCallback({ uid: "u1" });
  await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({ status: 401 });
  expect(mockSignOut).toHaveBeenCalledTimes(2);
});
