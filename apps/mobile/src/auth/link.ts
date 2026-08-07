// Completes the one-account-per-email merge: the user re-authenticates with the
// method their account already has, then the pending provider credential is
// linked onto that account.

import {
  GoogleAuthProvider,
  OAuthProvider,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  signInWithCredential,
  signInWithEmailAndPassword,
  type AuthCredential,
  type UserCredential,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

function requireAuth() {
  if (!auth) throw new Error("Firebase is not configured");
  return auth;
}

/**
 * Tags a failure of the RE-AUTH step. Firebase gives both the re-auth and the
 * link step `auth/invalid-credential` — "wrong password" in one, "expired
 * credential" in the other. Tagging by which call threw is the only way to tell
 * them apart; never branch on the code.
 */
function reauthFailed(cause: unknown): Error {
  return Object.assign(new Error("Re-authentication failed"), {
    code: "auth/reauth-failed",
    cause,
  });
}

/** Re-auth with the account's existing password, then attach `pending`. */
export async function completeLinkWithPassword(
  email: string,
  password: string,
  pending: AuthCredential,
): Promise<void> {
  let result: UserCredential;
  try {
    result = await signInWithEmailAndPassword(requireAuth(), email, password);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/** Re-auth with the account's existing Google identity, then attach `pending`. */
export async function completeLinkWithGoogle(
  googleIdToken: string,
  pending: AuthCredential,
): Promise<void> {
  const existing = GoogleAuthProvider.credential(googleIdToken);
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), existing);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/** Re-auth with the account's existing Apple identity, then attach `pending`. */
export async function completeLinkWithApple(
  appleIdToken: string,
  rawNonce: string,
  pending: AuthCredential,
): Promise<void> {
  const existing = new OAuthProvider("apple.com").credential({ idToken: appleIdToken, rawNonce });
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), existing);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/**
 * Sign-in methods already registered for `email` — e.g. ["password"],
 * ["google.com"]. Returns [] when email-enumeration protection is on, in which
 * case the caller must ask the user which method they used. Never throws: a
 * hint that cannot be fetched must not break the prompt.
 */
export async function existingSignInMethods(email: string): Promise<string[]> {
  try {
    return await fetchSignInMethodsForEmail(requireAuth(), email);
  } catch {
    return [];
  }
}
