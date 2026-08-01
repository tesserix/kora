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
