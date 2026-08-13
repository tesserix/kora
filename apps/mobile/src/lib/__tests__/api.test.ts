import {
  ApiError,
  CancelledError,
  NetworkError,
  REQUEST_TIMEOUT_MS,
  apiFetch,
  apiFetchEnvelope,
  apiFetchMultipart,
} from "../api";

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

jest.mock("../firebase", () => ({
  auth: { currentUser: { getIdToken: jest.fn().mockResolvedValue("test-token") } },
}));

// This file's requests always resolve to "test-token" on refresh too, so a
// 401 here never actually recovers — some of the failure-envelope tests
// below exercise api.ts's retry-then-sign-out path as a side effect. Session
// recovery itself (retry succeeds, retry still 401, concurrent bursts, 403
// vs 500, no signed-in user) is covered end to end in
// api-session-recovery.test.ts, which is why this mock only needs to not
// crash, not assert call counts.
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(),
  signOut: jest.fn(),
}));

beforeEach(() => {
  global.fetch = jest.fn();
});

test("attaches bearer token from firebase user", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { email: "a@b.c" } }),
  });

  await apiFetch("/v1/me");

  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers.Authorization).toBe("Bearer test-token");
});

test("throws ApiError with envelope fields on failure", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({ error: "unauthorized", message: "invalid or missing token" }),
  });

  await expect(apiFetch("/v1/me")).rejects.toThrow(ApiError);
  await expect(apiFetch("/v1/me")).rejects.toMatchObject({
    status: 401,
    code: "unauthorized",
  });
});

test("apiFetch unwraps the data field when present", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { email: "a@b.c" } }),
  });

  await expect(apiFetch("/v1/me")).resolves.toEqual({ email: "a@b.c" });
});

test("apiFetch returns the whole body when there is no data key", async () => {
  const body = { count: 3 };
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => body,
  });

  await expect(apiFetch("/v1/notifications/unread-count")).resolves.toEqual(body);
});

test("apiFetch returns the whole body when data is explicitly null", async () => {
  const body = { data: null, meta: { alias_recorded: false } };
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => body,
  });

  // `null ?? body` evaluates to `body` — the whole envelope, not `null`.
  await expect(apiFetch("/v1/logs/log1")).resolves.toEqual(body);
});

test("apiFetch delegates to apiFetchEnvelope for auth, headers, and error handling", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { id: "log1" } }),
  });

  await apiFetch("/v1/logs/log1");

  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe("http://localhost:8080/v1/logs/log1");
  expect(init.headers["Content-Type"]).toBe("application/json");
  expect(init.headers.Authorization).toBe("Bearer test-token");
});

test("apiFetchEnvelope returns the full envelope untouched", async () => {
  const body = { data: { id: "log1" }, meta: { alias_recorded: true } };
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => body,
  });

  await expect(apiFetchEnvelope("/v1/logs/log1", { method: "PATCH" })).resolves.toEqual(body);
});

test("apiFetchEnvelope throws ApiError with envelope fields on failure", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({ error: "not_found", message: "log not found" }),
  });

  await expect(apiFetchEnvelope("/v1/logs/missing")).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  });
});

test("apiFetchMultipart sends FormData without a JSON content-type and with the auth token", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { tier: "auto" } }),
  });

  const form = new FormData();
  form.append("file", { uri: "file:///x.jpg", name: "x.jpg", type: "image/jpeg" } as unknown as Blob);

  await apiFetchMultipart("/v1/resolve/photo", form);

  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.body).toBeInstanceOf(FormData);
  expect(init.headers.Authorization).toBe("Bearer test-token");
  expect(init.headers["Content-Type"]).toBeUndefined();
});

test("a request that outlives the deadline rejects as a timeout", async () => {
  jest.useFakeTimers();
  (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const promise = apiFetch("/v1/slow");
  jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
  await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  jest.useRealTimers();
});

// A caller's own Cancel has its own identity (#136 follow-up): folding it into
// NetworkError filed a crash report for every Cancel and made a cancel
// indistinguishable from a dropped connection everywhere downstream.
test("an aborted request rejects as CancelledError, not NetworkError, and does not resolve later", async () => {
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockImplementation((_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(abortError()))),
  );
  const promise = apiFetch("/v1/slow", { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toBeInstanceOf(CancelledError);
  await expect(promise).rejects.not.toBeInstanceOf(NetworkError);
});

test("a signal already aborted before the request starts also rejects as CancelledError", async () => {
  const controller = new AbortController();
  controller.abort();
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });

  await expect(apiFetch("/v1/slow", { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
});

// The composed signal carries BOTH the caller's cancel and the 25s deadline.
// A deadline that fired while a caller signal was attached must still be a
// TimeoutError — a timeout is a fault worth reporting and worth queueing a
// capture for; a cancel is neither.
test("the deadline still produces TimeoutError when a caller signal is attached", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const promise = apiFetch("/v1/slow", { signal: controller.signal });
  jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
  await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  await expect(promise).rejects.not.toBeInstanceOf(CancelledError);
  jest.useRealTimers();
});

// The other half of the discriminant: a genuine transport failure is still a
// NetworkError, so the offline queue's classifier is untouched by this change.
test("a genuine fetch failure with a caller signal attached is still a NetworkError", async () => {
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Network request failed"));

  const promise = apiFetch("/v1/slow", { signal: controller.signal });
  await expect(promise).rejects.toBeInstanceOf(NetworkError);
  await expect(promise).rejects.not.toBeInstanceOf(CancelledError);
});

test("the client deadline is below the gateway's 30s cut-off", () => {
  expect(REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
});

test("a fast response clears the deadline timer instead of leaving it pending", async () => {
  jest.useFakeTimers();
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { ok: true } }),
  });

  await apiFetch("/v1/fast");

  // If the timer were still pending, advancing past it would throw a
  // TimeoutError from a request that already completed. Nothing to await
  // here — a leaked timer would need to actually fire an unhandled
  // rejection, which fake timers surface as a thrown error from this call.
  expect(() => jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1)).not.toThrow();
  jest.useRealTimers();
});

test("apiFetchMultipart forwards a caller signal that can abort the request", async () => {
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockImplementation((_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(abortError()))),
  );
  const form = new FormData();

  const promise = apiFetchMultipart("/v1/resolve/photo", form, { signal: controller.signal });
  controller.abort();

  await expect(promise).rejects.toBeInstanceOf(CancelledError);
});
