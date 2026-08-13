const mockReportError = jest.fn();
jest.mock("@/observability/reporter", () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
  initReporting: jest.fn(),
  setReportingUser: jest.fn(),
}));

jest.mock("../firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(),
  signOut: jest.fn(),
}));

import { apiFetch } from "../api";

const realFetch = global.fetch;

beforeEach(() => {
  mockReportError.mockClear();
});

afterEach(() => {
  global.fetch = realFetch;
});

test("a 500 is reported once, with the route", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ error: "internal", message: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req-99" },
    }),
  ) as unknown as typeof fetch;

  await expect(apiFetch("/v1/dashboard")).rejects.toBeDefined();

  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error, context] = mockReportError.mock.calls[0];
  expect((error as { status?: number }).status).toBe(500);
  expect(context).toEqual({ route: "/v1/dashboard" });
});

test("a 401 reaches the reporter, which is what drops it — the call site does not decide", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ error: "unauthorized", message: "nope" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;

  await expect(apiFetch("/v1/me")).rejects.toBeDefined();

  // api.ts reports unconditionally; isReportable (unit-tested in Task 2) is
  // what filters. Asserting the call happens here proves the wiring, and
  // proves the filtering is NOT duplicated at the call site.
  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error] = mockReportError.mock.calls[0];
  expect((error as { status?: number }).status).toBe(401);
});

test("a 200 whose body will not parse is reported as a ResponseParseError", async () => {
  // The headline case: a 200 that the client cannot read. It only reaches the
  // reporter if apiFetchEnvelope AWAITS parseJson inside its try — a bare
  // `return parseJson(...)` adopts the promise outside the try and the catch
  // never fires.
  global.fetch = jest.fn(async () =>
    new Response("<html>not json</html>", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;

  await expect(apiFetch("/v1/dashboard")).rejects.toBeDefined();

  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error, context] = mockReportError.mock.calls[0];
  expect((error as { name?: string }).name).toBe("ResponseParseError");
  expect(context).toEqual({ route: "/v1/dashboard" });
});

// api.ts still reports unconditionally (isReportable is what filters), but the
// error it hands the reporter must be the honest one: a Cancel reaching
// Crashlytics as a NetworkError is a fault report for something that never
// failed, filed once per Cancel and once per unmount-while-resolving.
test("a cancelled request hands the reporter a CancelledError, not a NetworkError", async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(
    (_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
  ) as unknown as typeof fetch;

  const promise = apiFetch("/v1/resolve/photo", { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toBeDefined();

  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error] = mockReportError.mock.calls[0];
  expect((error as { name?: string }).name).toBe("CancelledError");
});

test("a successful request reports nothing", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;

  await apiFetch("/v1/dashboard");

  expect(mockReportError).not.toHaveBeenCalled();
});
