import { authErrorMessage, holdCredentials, passwordProblem, takeCredentials } from "../flow";
import { sessionMock } from "@/test/sessionMock";

test("passwordProblem mirrors Zitadel's complexity policy", () => {
  expect(passwordProblem("Str0ng!Password")).toBeNull();
  for (const weak of ["Sh0rt!Pass", "nouppercase1!xx", "NOLOWERCASE1!XX", "NoNumbersHere!!", "NoSymbols12345x", "A1!" + "a".repeat(67)]) {
    expect(passwordProblem(weak)).not.toBeNull();
  }
});

test("held credentials go to the matching email, once", () => {
  holdCredentials("ann@example.com", "pw");
  expect(takeCredentials("other@example.com")).toBeNull();
  // A mismatched take still clears them: they are never left lying around.
  expect(takeCredentials("ann@example.com")).toBeNull();
  holdCredentials("ann@example.com", "pw");
  expect(takeCredentials("ann@example.com")).toEqual({ email: "ann@example.com", password: "pw" });
  expect(takeCredentials("ann@example.com")).toBeNull();
});

test("authErrorMessage prefers kora-api's wording and is silent on cancel", () => {
  expect(authErrorMessage(new sessionMock.AuthSessionError("cancelled"))).toBeNull();
  expect(authErrorMessage(new sessionMock.AuthSessionError("email_taken", "Taken."))).toBe("Taken.");
  expect(authErrorMessage(new TypeError("Network request failed"))).toMatch(/offline/);
  expect(authErrorMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
});
