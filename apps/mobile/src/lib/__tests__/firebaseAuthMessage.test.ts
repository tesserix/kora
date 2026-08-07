import { firebaseAuthMessage } from "../firebaseAuthMessage";

test.each([
  ["auth/email-already-in-use", "That email already has an account. Try signing in."],
  ["auth/weak-password", "Choose a password of at least 6 characters."],
  ["auth/invalid-email", "That doesn't look like a valid email address."],
  ["auth/network-request-failed", "Couldn't reach Kora. Check your connection."],
  ["auth/too-many-requests", "Too many attempts. Wait a moment and try again."],
])("maps %s to its own specific message", (code, expected) => {
  expect(firebaseAuthMessage({ code })).toBe(expected);
});

test.each(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"])(
  "%s stays deliberately vague so it cannot be used to enumerate accounts",
  (code) => {
    // Distinguishing "no such account" from "wrong password" would tell an
    // attacker which email addresses are registered.
    expect(firebaseAuthMessage({ code })).toBe("Email or password is incorrect.");
  },
);

test("every mapped message is distinct from the generic fallback", () => {
  // Guards the whole point of this helper: a mapping that silently resolved to
  // the fallback would be no better than the catch-all it replaced.
  const codes = [
    "auth/email-already-in-use",
    "auth/weak-password",
    "auth/invalid-email",
    "auth/network-request-failed",
    "auth/too-many-requests",
    "auth/invalid-credential",
  ];
  for (const code of codes) {
    expect(firebaseAuthMessage({ code })).not.toBe("Something went wrong. Please try again.");
  }
});

test("an unknown code falls back to a generic message", () => {
  expect(firebaseAuthMessage({ code: "auth/some-future-code" })).toBe(
    "Something went wrong. Please try again.",
  );
});

test("a non-Firebase value does not throw and still yields the fallback", () => {
  expect(firebaseAuthMessage(undefined)).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage(null)).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage({})).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage({ code: 42 })).toBe("Something went wrong. Please try again.");
});

import { AuthCancelledError, LastSignInMethodError } from "@/auth/errors";

test("returns null for a cancelled sign-in so callers render nothing", () => {
  expect(firebaseAuthMessage(new AuthCancelledError())).toBeNull();
});

test("returns null for Apple's raw cancellation code that bypassed the wrapper", () => {
  expect(firebaseAuthMessage({ code: "ERR_REQUEST_CANCELED" })).toBeNull();
});

test("explains the iCloud precondition for ERR_REQUEST_UNKNOWN", () => {
  expect(firebaseAuthMessage({ code: "ERR_REQUEST_UNKNOWN" })).toContain("iCloud");
});

test("names the last-sign-in-method refusal", () => {
  expect(firebaseAuthMessage(new LastSignInMethodError())).toBe(
    "You can't remove your only sign-in method.",
  );
});

// The tag test. auth/reauth-failed and auth/invalid-credential are produced by
// DIFFERENT steps; the same raw code cannot distinguish them, so the copy must
// differ by tag. Three distinct outputs, asserted as mutually distinct rather
// than against one literal, so a stub returning a constant fails.
test("distinguishes the re-auth failure by context", () => {
  const password = firebaseAuthMessage({ code: "auth/reauth-failed" }, { method: "password" });
  const social = firebaseAuthMessage(
    { code: "auth/reauth-failed" },
    { method: "social", provider: "google.com" },
  );
  const untagged = firebaseAuthMessage({ code: "auth/reauth-failed" });

  expect(password).toBe("That password is incorrect.");
  expect(social).not.toBe(password);
  expect(untagged).not.toBe(password);
  expect(untagged).not.toBe(social);
});

test("never claims 'password' when no context was supplied", () => {
  expect(firebaseAuthMessage({ code: "auth/reauth-failed" })).not.toContain("password");
});

test("maps the link-specific codes", () => {
  expect(firebaseAuthMessage({ code: "auth/credential-already-in-use" })).toContain("already linked");
  expect(firebaseAuthMessage({ code: "auth/provider-already-linked" })).toContain("already linked");
  expect(firebaseAuthMessage({ code: "auth/requires-recent-login" })).toContain("sign in again");
});

test("keeps the existing enumeration-safe grouping", () => {
  const invalid = firebaseAuthMessage({ code: "auth/invalid-credential" });
  expect(firebaseAuthMessage({ code: "auth/wrong-password" })).toBe(invalid);
  expect(firebaseAuthMessage({ code: "auth/user-not-found" })).toBe(invalid);
});

test("never returns a raw message from an unknown error", () => {
  const msg = firebaseAuthMessage({ code: "auth/nope", message: "/Users/x/Native.swift:42 boom" });
  expect(msg).toBe("Something went wrong. Please try again.");
  expect(msg).not.toContain("Native.swift");
});

// auth/invalid-credential is what Firebase throws when a provider ID token is
// rejected — including when the provider is not yet enabled on the project,
// which is this branch's actual pre-configuration state. Untagged and
// password-tagged callers must keep the exact existing enumeration-safe copy;
// only a social tag may change the wording, and it must not mention a password.
describe("auth/invalid-credential branches on context", () => {
  const untagged = firebaseAuthMessage({ code: "auth/invalid-credential" });
  const password = firebaseAuthMessage({ code: "auth/invalid-credential" }, { method: "password" });
  const social = firebaseAuthMessage(
    { code: "auth/invalid-credential" },
    { method: "social", provider: "apple.com" },
  );

  test("untagged keeps today's exact enumeration-safe copy", () => {
    expect(untagged).toBe("Email or password is incorrect.");
  });

  test("password-tagged keeps today's exact enumeration-safe copy", () => {
    expect(password).toBe("Email or password is incorrect.");
  });

  test("social-tagged does not mention a password and differs from the password copy", () => {
    expect(social).not.toContain("password");
    expect(social).not.toBe(untagged);
    expect(social).not.toBe(password);
  });
});

test("auth/operation-not-allowed gets its own copy, not the generic fallback", () => {
  const msg = firebaseAuthMessage({ code: "auth/operation-not-allowed" });
  expect(msg).not.toBe("Something went wrong. Please try again.");
  expect(msg).not.toBe("Email or password is incorrect.");
});

// src/lib/api.ts documents this exact hazard for NetworkError: a class-identity
// mismatch across module realms means `instanceof` alone can miss a real
// cancellation. Google's cancellation produces ONLY AuthCancelledError with no
// code-based safety net, so the `name` check matters here specifically.
test("recognises a cancellation by name even without the class's prototype", () => {
  const fakeCancellation = { name: "AuthCancelledError" };
  expect(firebaseAuthMessage(fakeCancellation)).toBeNull();
});
