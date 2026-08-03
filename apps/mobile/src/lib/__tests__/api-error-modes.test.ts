// Covers the three failure modes that used to collapse into one anonymous
// thrown value (see the "Something went wrong while I looked at that"
// incident): an auth-token failure (getIdToken rejects, before any request
// is sent), a network/transport failure (fetch itself rejects, no response
// at all), and a response-parse failure (a 2xx whose body will not parse).
// Also covers that a plain HTTP error status still produces the unchanged
// ApiError, now carrying the server's X-Request-Id when present.
//
// Follows api-session-recovery.test.ts's pattern: jest.resetModules() +
// jest.isolateModules() gives each test a fresh copy of api.ts so the
// module-level session-expiry state can't leak between tests, and so
// getIdToken/fetch can be configured per test without interference.

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

function okResponse(body: unknown, headers: Record<string, string> = {}): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null } as Headers,
    json: async () => body,
  };
}

function failResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Partial<Response> {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name] ?? null } as Headers,
    json: async () => body,
  };
}

describe("auth-token failure", () => {
  test("getIdToken rejecting produces AuthTokenError, and no fetch is attempted", async () => {
    const getIdToken = jest.fn().mockRejectedValue(new Error("token unavailable"));
    loadApiWithAuth(mockUser(getIdToken));

    await expect(api.apiFetch("/v1/today")).rejects.toBeInstanceOf(api.AuthTokenError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("AuthTokenError preserves the original rejection as cause", async () => {
    const original = new Error("token unavailable");
    const getIdToken = jest.fn().mockRejectedValue(original);
    loadApiWithAuth(mockUser(getIdToken));

    let caught: unknown;
    try {
      await api.apiFetch("/v1/today");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(api.AuthTokenError);
    expect((caught as Error).cause).toBe(original);
  });
});

describe("network/transport failure", () => {
  test("fetch rejecting produces NetworkError", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Network request failed"));

    await expect(api.apiFetch("/v1/today")).rejects.toBeInstanceOf(api.NetworkError);
  });

  test("NetworkError preserves the original fetch rejection as cause", async () => {
    const original = new TypeError("Network request failed");
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockRejectedValue(original);

    let caught: unknown;
    try {
      await api.apiFetch("/v1/today");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(api.NetworkError);
    expect((caught as Error).cause).toBe(original);
  });

  // One discriminant for the whole codebase. The class is what api.ts throws,
  // but the offline queue's tests and its fake server reproduce this failure
  // the way errors are named elsewhere — `{ name: "NetworkError" }` — and a
  // caller that recognised only the class would take the rethrow path on those
  // and lose the write. Both shapes, one predicate.
  test("isNetworkError recognises the class", () => {
    loadApiWithAuth(mockUser(jest.fn()));
    expect(api.isNetworkError(new api.NetworkError(new TypeError("boom")))).toBe(true);
  });

  test("isNetworkError recognises a duck-typed NetworkError", () => {
    loadApiWithAuth(mockUser(jest.fn()));
    const ducked = Object.assign(new Error("Network request failed"), { name: "NetworkError" });
    expect(api.isNetworkError(ducked)).toBe(true);
  });

  test("isNetworkError rejects other failures and non-errors", () => {
    loadApiWithAuth(mockUser(jest.fn()));
    expect(api.isNetworkError(new api.ApiError(400, "bad_request", "nope"))).toBe(false);
    expect(api.isNetworkError(new api.AuthTokenError(new Error("no token")))).toBe(false);
    expect(api.isNetworkError(null)).toBe(false);
    expect(api.isNetworkError(undefined)).toBe(false);
  });
});

describe("response-parse failure", () => {
  test("a 2xx response with an unparseable body produces ResponseParseError (apiFetch)", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null } as unknown as Headers,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    await expect(api.apiFetch("/v1/today")).rejects.toBeInstanceOf(api.ResponseParseError);
  });

  test("a 2xx response with an unparseable body produces ResponseParseError (apiFetchMultipart)", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null } as unknown as Headers,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    const form = new FormData();
    form.append("file", { uri: "file:///x.jpg", name: "x.jpg", type: "image/jpeg" } as unknown as Blob);

    await expect(api.apiFetchMultipart("/v1/resolve/photo", form)).rejects.toBeInstanceOf(
      api.ResponseParseError,
    );
  });

  test("ResponseParseError preserves the original parse failure as cause", async () => {
    const original = new SyntaxError("Unexpected end of JSON input");
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null } as unknown as Headers,
      json: async () => {
        throw original;
      },
    });

    let caught: unknown;
    try {
      await api.apiFetch("/v1/today");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(api.ResponseParseError);
    expect((caught as Error).cause).toBe(original);
  });
});

describe("ApiError request id", () => {
  test("an HTTP error status still produces ApiError, carrying the request id when present", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockResolvedValue(
      failResponse(404, { error: "not_found", message: "no route" }, { "X-Request-Id": "req-abc-123" }),
    );

    await expect(api.apiFetch("/v1/today")).rejects.toBeInstanceOf(api.ApiError);
    await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      requestId: "req-abc-123",
    });
  });

  test("ApiError.requestId is undefined when the header is absent", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));
    (global.fetch as jest.Mock).mockResolvedValue(failResponse(500, { error: "internal", message: "boom" }));

    await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({
      status: 500,
      requestId: undefined,
    });
  });
});

describe("401 refresh-and-retry is unaffected by the new error types", () => {
  test("a 401 followed by a successful retry still returns data and does not sign out", async () => {
    const getIdToken = jest
      .fn()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    loadApiWithAuth(mockUser(getIdToken));

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(failResponse(401, { error: "unauthorized", message: "expired" }))
      .mockResolvedValueOnce(okResponse({ data: { ok: true } }));

    await expect(api.apiFetch("/v1/today")).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  test("a 401 that repeats on retry still calls signOut exactly once and rejects with ApiError", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));

    (global.fetch as jest.Mock).mockResolvedValue(
      failResponse(401, { error: "unauthorized", message: "expired" }, { "X-Request-Id": "req-401" }),
    );

    await expect(api.apiFetch("/v1/today")).rejects.toMatchObject({
      status: 401,
      requestId: "req-401",
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("a 401 followed by a rejecting fetch on retry surfaces NetworkError, not ApiError, and still does not sign out", async () => {
    const getIdToken = jest.fn().mockResolvedValue("token");
    loadApiWithAuth(mockUser(getIdToken));

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(failResponse(401, { error: "unauthorized", message: "expired" }))
      .mockRejectedValueOnce(new TypeError("Network request failed"));

    await expect(api.apiFetch("/v1/today")).rejects.toBeInstanceOf(api.NetworkError);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
