import { ApiError, apiFetch, apiFetchMultipart } from "../api";

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
