import { auth, isFirebaseConfigured } from "@/lib/firebase";

// Three states, not a boolean. "Not signed in" and "we have no Firebase at all"
// demand opposite responses from the reminder code: a signed-out user's local
// reminders must be disarmed, whereas a missing config must NOT destroy
// a working user's schedule as a side effect of a configuration problem.
export type AuthState = "unconfigured" | "signed-in" | "signed-out";

// resolveAuthState answers "is someone signed in right now" AFTER Firebase has
// finished restoring any persisted session.
//
// The await is the load-bearing part. Auth persistence is AsyncStorage-backed
// (src/lib/firebase.ts), so `auth.currentUser` is null for the first moments of
// every cold start — including for a user who is very much signed in. Reading
// it synchronously at launch (setupPushHandler runs at module scope) would
// classify every launch as signed-out and wipe the user's reminders.
export async function resolveAuthState(): Promise<AuthState> {
  if (!isFirebaseConfigured || !auth) return "unconfigured";
  try {
    await auth.authStateReady();
  } catch {
    // Deliberately swallowed — see src/lib/push.ts for this convention. If the
    // readiness promise ever rejects we still fall through to currentUser,
    // which is the same answer this function gave before authStateReady existed.
  }
  return auth.currentUser ? "signed-in" : "signed-out";
}
