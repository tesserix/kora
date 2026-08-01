// Firebase auth errors carry a `code`. The shipped sign-in screen collapsed every
// failure to "Sign-in failed. Check your email and password.", which is actively
// wrong for a weak password or a network outage — it tells the user to check the
// one thing that was fine, and discards the only actionable detail there was.
//
// invalid-credential / wrong-password / user-not-found deliberately SHARE one
// vague message: distinguishing "no such account" from "wrong password" would let
// an attacker enumerate which email addresses are registered.
const MESSAGES: Record<string, string> = {
  "auth/email-already-in-use": "That email already has an account. Try signing in.",
  "auth/weak-password": "Choose a password of at least 6 characters.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/network-request-failed": "Couldn't reach Kora. Check your connection.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
};

const FALLBACK = "Something went wrong. Please try again.";

export function firebaseAuthMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return FALLBACK;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}
