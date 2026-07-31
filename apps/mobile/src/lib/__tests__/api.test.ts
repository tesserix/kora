import { ApiError, apiFetch, apiFetchEnvelope, apiFetchMultipart } from "../api";

jest.mock("../firebase", () => ({
  auth: { currentUser: { getIdToken: jest.fn().mockResolvedValue("test-token") } },
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
