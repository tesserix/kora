import { deleteAccount } from "@/api/hooks";

const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(undefined);
});

// toHaveBeenCalledWith is a recursive equality check on the whole init object,
// so this also pins that no body is sent — the server takes the user from the
// auth context, and an added `body` key would fail this assertion.
test("issues DELETE to /v1/me, with no body", async () => {
  await deleteAccount();
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/me", { method: "DELETE" });
});

test("propagates a rejection so the screen can surface it", async () => {
  const boom = new Error("nope");
  mockApiFetch.mockRejectedValue(boom);
  await expect(deleteAccount()).rejects.toBe(boom);
});
