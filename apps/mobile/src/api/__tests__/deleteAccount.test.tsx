const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import { deleteAccount } from "@/api/hooks";

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(undefined);
});

test("issues DELETE to /v1/me", async () => {
  await deleteAccount();
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/me", { method: "DELETE" });
});

test("sends no body — the server takes the user from the auth context", async () => {
  await deleteAccount();
  const init = mockApiFetch.mock.calls[0][1] as RequestInit;
  expect(init.body).toBeUndefined();
});

test("propagates a rejection so the screen can surface it", async () => {
  const boom = new Error("nope");
  mockApiFetch.mockRejectedValue(boom);
  await expect(deleteAccount()).rejects.toBe(boom);
});
