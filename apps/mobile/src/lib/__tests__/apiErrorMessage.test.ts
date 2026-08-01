// ApiError lives in api.ts, which pulls in firebase/auth at import time.
// Same mocks api.test.ts installs — this file only needs the import not to
// crash, since apiErrorMessage is pure.
jest.mock("../firebase", () => ({ auth: null }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(), signOut: jest.fn() }));

import { ApiError } from "../api";
import { apiErrorMessage } from "../apiErrorMessage";

const CHECK_DETAILS = "Please check your details and try again.";
const SERVER = "Kora is having trouble right now. Please try again in a moment.";
const OFFLINE = "Couldn't reach Kora. Check your connection.";

test("a 400 is the user's input, so it asks them to check their details", () => {
  expect(apiErrorMessage(new ApiError(400, "invalid_input", "bad"))).toBe(CHECK_DETAILS);
});

test("a 422 is also treated as input", () => {
  expect(apiErrorMessage(new ApiError(422, "invalid_input", "bad"))).toBe(CHECK_DETAILS);
});

test.each([500, 502, 503, 504])(
  "a %i is NOT the user's fault and must not blame their details",
  (status) => {
    // The shipped screen told a user whose input was fine to go re-check it
    // while the server was down — sending them round a loop they cannot exit.
    const msg = apiErrorMessage(new ApiError(status, "internal_error", "boom"));
    expect(msg).toBe(SERVER);
    expect(msg).not.toBe(CHECK_DETAILS);
  },
);

test("a network failure (no response at all) is reported as connectivity", () => {
  // fetch rejects with a TypeError when the request never reaches a server.
  expect(apiErrorMessage(new TypeError("Network request failed"))).toBe(OFFLINE);
});

test("an unknown non-ApiError falls back to the server message, not a details blame", () => {
  expect(apiErrorMessage(new Error("something odd"))).toBe(SERVER);
  expect(apiErrorMessage(undefined)).toBe(SERVER);
  expect(apiErrorMessage(null)).toBe(SERVER);
});

test("a 404 is a server-side problem from the user's point of view", () => {
  expect(apiErrorMessage(new ApiError(404, "not_found", "no route"))).toBe(SERVER);
});

test("the three messages are distinct, so the cause is always distinguishable", () => {
  expect(new Set([CHECK_DETAILS, SERVER, OFFLINE]).size).toBe(3);
});
