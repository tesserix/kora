import { ApiError, apiFetch } from "../api";

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
