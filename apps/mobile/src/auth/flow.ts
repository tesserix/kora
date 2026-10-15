// Shared pieces of the sign-in screens: the copy for a failed step, the
// password rules Zitadel enforces, and the credentials held between sign-up
// and the email code.
import { AuthSessionError } from "./session";

// authErrorMessage maps a failed auth step to the line shown under the form,
// or null when there is nothing to say (the person closed the sheet).
// kora-api's refusals carry their own user-facing wording, which wins.
export function authErrorMessage(err: unknown): string | null {
  if (err instanceof AuthSessionError) {
    if (err.code === "cancelled") return null;
    if (err.userMessage) return err.userMessage;
    if (err.code === "provider_failed") return "That sign-in didn't complete. Please try again.";
  }
  if (err instanceof TypeError) return "You appear to be offline. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}

// needsSecondFactor reports a sign-in step that stopped for an authenticator
// code. session.ts has held the sign-in; the caller goes to /two-step.
export function needsSecondFactor(err: unknown): boolean {
  return err instanceof AuthSessionError && err.code === "totp_required";
}

// Zitadel's password complexity policy on the TESSERIX org. Checked here only
// to answer before a round trip; kora-api's weak_password stays the authority.
export const PASSWORD_RULES = "At least 12 characters, with upper and lower case letters, a number and a symbol.";

export function passwordProblem(password: string): string | null {
  const ok =
    password.length >= 12 &&
    password.length < 70 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  return ok ? null : PASSWORD_RULES;
}

// The email and password typed on sign-up (or on a sign-in refused for an
// unverified email), held so a verified code signs straight in instead of
// asking for the password a second time. Memory only: never persisted, never
// put in route params, and handed out at most once.
let held: { email: string; password: string } | null = null;

export function holdCredentials(email: string, password: string): void {
  held = { email, password };
}

export function takeCredentials(email: string): { email: string; password: string } | null {
  const out = held && held.email === email ? held : null;
  held = null;
  return out;
}
