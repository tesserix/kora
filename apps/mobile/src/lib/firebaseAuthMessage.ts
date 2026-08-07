import { AuthCancelledError, LastSignInMethodError, type AuthErrorContext } from "@/auth/errors";

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
  // Added for social sign-in and provider linking.
  "auth/credential-already-in-use": "That account is already linked to a different Kora account.",
  "auth/provider-already-linked": "That's already linked to your account.",
  "auth/requires-recent-login": "For security, sign out and sign in again, then retry.",
  "auth/user-disabled": "That account has been disabled. Contact support.",
  // The literal Firebase error for a provider not yet enabled on the project —
  // the exact state this branch ships in before Firebase/Apple console setup.
  "auth/operation-not-allowed": "That sign-in method isn't available yet.",
  "ERR_REQUEST_UNKNOWN":
    "Couldn't complete Apple sign-in. Make sure you're signed in to iCloud on this device.",
};

const FALLBACK = "Something went wrong. Please try again.";

// `auth/reauth-failed` is a TAG set by link.ts at the re-auth call site, not a
// Firebase code. It exists because the re-auth step and the link step both
// surface `auth/invalid-credential`, meaning "wrong password" in one and
// "expired credential" in the other — the code alone cannot separate them.
function reauthFailedMessage(ctx?: AuthErrorContext): string {
  if (ctx?.method === "password") return "That password is incorrect.";
  if (ctx?.method === "social") return "Couldn't verify that account. Try again.";
  // Forgetting to pass a context must never produce confidently WRONG copy, so
  // stay neutral rather than guessing "password".
  return "Couldn't verify your account. Try again.";
}

/**
 * Returns `null` ONLY when the user cancelled — callers must render nothing.
 * Never returns a raw `error.message`: native SDK strings carry Swift file
 * paths and internals that must not reach a user.
 */
export function firebaseAuthMessage(error: unknown, ctx?: AuthErrorContext): string | null {
  // `instanceof` is the precise check; the `name` branch is what catches a value
  // whose class identity did not survive a module realm boundary (same hazard
  // documented for NetworkError in src/lib/api.ts). Google's cancellation
  // produces ONLY AuthCancelledError with no code-based safety net.
  if (
    error instanceof AuthCancelledError ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AuthCancelledError")
  ) {
    return null;
  }
  if (error instanceof LastSignInMethodError) return "You can't remove your only sign-in method.";
  if (typeof error !== "object" || error === null) return FALLBACK;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return FALLBACK;
  // Safety net for a raw Apple cancellation that bypassed the socialAuth wrapper.
  if (code === "ERR_REQUEST_CANCELED") return null;
  if (code === "auth/reauth-failed") return reauthFailedMessage(ctx);
  // auth/invalid-credential is exactly what Firebase throws when a provider ID
  // token is rejected — including when the provider is not enabled on the
  // project. Untagged and password contexts keep the deliberate enumeration-safe
  // copy; only a social tag gets neutral, provider-agnostic wording, since
  // telling a social sign-in attempt that its PASSWORD was wrong is actively
  // false — no password was ever entered.
  if (code === "auth/invalid-credential" && ctx?.method === "social") {
    return "Couldn't verify that account. Try again.";
  }
  return MESSAGES[code] ?? FALLBACK;
}
