import { deleteAccount } from "@/api/hooks";

const mockApiFetch = jest.fn();
// The reminder scheduler now consults the signed-in user before it (re-)arms
// anything (#171), which pulls @/lib/firebase into this module graph — and
// firebase ships ESM that Jest cannot transform. A signed-in stub keeps the
// import hermetic and preserves the pre-#171 behaviour of these tests, where
// the reconcile pass ran unconditionally.
jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { authStateReady: async () => {}, currentUser: { uid: "test-user" } },
}));

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
