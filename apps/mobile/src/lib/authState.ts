import { authReady, currentUserId, isAuthConfigured } from "@/auth/session";

// Three states, not a boolean. "Not signed in" and "this build has no sign-in
// configured" demand opposite responses from the reminder code: a signed-out
// user's local reminders must be disarmed, whereas a missing config must NOT
// destroy a working user's schedule as a side effect of a configuration
// problem.
export type AuthState = "unconfigured" | "signed-in" | "signed-out";

// resolveAuthState answers "is someone signed in right now" AFTER the persisted
// session has been read.
//
// The await is the load-bearing part. The session lives in SecureStore
// (src/auth/session.ts), so currentUserId() is null for the first moments of
// every cold start — including for a user who is very much signed in. Reading
// it synchronously at launch (setupPushHandler runs at module scope) would
// classify every launch as signed-out and wipe the user's reminders.
export async function resolveAuthState(): Promise<AuthState> {
  if (!isAuthConfigured) return "unconfigured";
  try {
    await authReady();
  } catch {
    // Deliberately swallowed — see src/lib/push.ts for this convention. If the
    // restore ever rejects we still fall through to the in-memory session.
  }
  return currentUserId() ? "signed-in" : "signed-out";
}
