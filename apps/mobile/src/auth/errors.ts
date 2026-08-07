// Firebase-free error types for the auth layer. Kept out of `link.ts` and
// `socialCredentials.ts` (which value-import `firebase/auth`) so route files can
// catch these without pulling the auth chain into their import graph.

/** Thrown when unlinking would remove the user's only remaining sign-in method. */
export class LastSignInMethodError extends Error {
  constructor() {
    super("Cannot remove the only sign-in method");
    this.name = "LastSignInMethodError";
  }
}

/** The user dismissed a native sign-in sheet. Callers show NOTHING. */
export class AuthCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "AuthCancelledError";
  }
}

export type AuthErrorContext =
  | { method: "password" }
  | { method: "social"; provider: "google.com" | "apple.com" };
