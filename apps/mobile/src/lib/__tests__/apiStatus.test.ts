// ApiError lives in api.ts, which pulls in firebase/auth at import time. Same
// mocks apiErrorMessage.test.ts installs — this file only needs the import not
// to crash, since isNotFound is pure. Importing the REAL class is the point:
// it is what stops the duck-typed check drifting away from the class it models.
import { ApiError } from "../api";
import { isNotFound } from "../apiStatus";

jest.mock("../firebase", () => ({ auth: null }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(), signOut: jest.fn() }));

test("a real ApiError 404 is recognised", () => {
  expect(isNotFound(new ApiError(404, "not_found", "Not found."))).toBe(true);
});

test("other statuses are not", () => {
  for (const s of [400, 401, 403, 409, 500, 503]) {
    expect(isNotFound(new ApiError(s, "e", "m"))).toBe(false);
  }
});

// A network failure has no status at all, and must never be mistaken for a
// deliberate 404 — that would render an outage as "nothing shared with you".
test("a network failure is not a 404", () => {
  expect(isNotFound(Object.assign(new Error("down"), { name: "NetworkError" }))).toBe(false);
});

test("junk is not a 404", () => {
  for (const v of [null, undefined, "404", 404, {}, { status: 404 }, { name: "ApiError" }]) {
    expect(isNotFound(v)).toBe(false);
  }
});
