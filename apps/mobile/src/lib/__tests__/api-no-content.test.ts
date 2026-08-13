// A bodiless success is still a success. DELETE /v1/me answers 204 with no
// body (api/internal/user/handler.go), and 204 satisfies `res.ok` — so before
// this was handled, apiFetchEnvelope fell through to res.json() on an empty
// body, threw, and reported a completed, irreversible account deletion to the
// user as "Kora is having trouble right now". These tests drive the REAL
// apiFetch/apiFetchEnvelope against a real bodiless Response, which is the
// only way to reproduce that: a hand-rolled `{ json: async () => ... }` fake
// cannot, because it always has a body to parse.

import { apiFetch, apiFetchEnvelope } from "../api";

jest.mock("../firebase", () => ({
  auth: { currentUser: { getIdToken: jest.fn().mockResolvedValue("test-token") } },
}));

jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(),
  signOut: jest.fn(),
}));

beforeEach(() => {
  global.fetch = jest.fn();
});

test("apiFetch resolves on a bodiless 204 instead of throwing ResponseParseError", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(new Response(null, { status: 204 }));

  await expect(apiFetch("/v1/me", { method: "DELETE" })).resolves.toBeDefined();
});

test("apiFetchEnvelope resolves on a bodiless 204 with no data", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(new Response(null, { status: 204 }));

  await expect(apiFetchEnvelope("/v1/me", { method: "DELETE" })).resolves.toEqual({ data: undefined });
});

// The guard must be keyed on the no-content status, not on "the body failed to
// parse" — a 200 whose body is unreadable is still a genuine parse failure and
// must keep surfacing as one.
test("a 200 with an unparseable body still throws, unchanged", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(new Response("not json", { status: 200 }));

  await expect(apiFetch("/v1/today")).rejects.toBeTruthy();
});

test("a 200 with a real body is still parsed and unwrapped", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    new Response(JSON.stringify({ data: { email: "a@b.c" } }), { status: 200 }),
  );

  await expect(apiFetch("/v1/me")).resolves.toEqual({ email: "a@b.c" });
});
