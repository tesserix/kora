import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  updateProfile,
  type AuthCredential,
  type UserCredential,
} from "firebase/auth";
import { toByteArray } from "base64-js";
import { auth } from "@/lib/firebase";
import { setDisplayName, storeAppleAuthorization } from "@/api/hooks";
import type { AppleFullName } from "@/lib/socialAuth";

/**
 * `needs-link` means the project is one-account-per-email and an account
 * already exists for this email under a different provider — the caller must
 * have the user re-authenticate with their existing method, then link
 * `pendingCredential` onto it.
 */
export type SocialSignInOutcome =
  | { status: "signed-in" }
  | {
      status: "needs-link";
      email: string;
      provider: "google.com" | "apple.com";
      pendingCredential: AuthCredential;
    };

const ACCOUNT_EXISTS = "auth/account-exists-with-different-credential";

function isAccountExistsConflict(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === ACCOUNT_EXISTS
  );
}

/**
 * Best-effort read of the `email` claim from a provider id_token, used only to
 * decide which account the user must re-authenticate as. A UX hint, not a trust
 * decision — Firebase validates the signature server-side — so the payload is
 * decoded without verification. Returns "" for any malformed token.
 */
function emailFromIdToken(idToken: string): string {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const bytes = toByteArray(padded);
    const json = decodeURIComponent(
      Array.from(bytes)
        .map((b) => "%" + b.toString(16).padStart(2, "0"))
        .join(""),
    );
    const claims: unknown = JSON.parse(json);
    const email = (claims as { email?: unknown }).email;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

function needsLinkEmail(idToken: string, e: unknown): string {
  const fromToken = emailFromIdToken(idToken);
  if (fromToken) return fromToken;
  // JS SDK v9+ surfaces the conflicting email on customData (the native SDK
  // used userInfo — do not copy that shape here).
  const fromCustom = (e as { customData?: { email?: unknown } }).customData?.email;
  return typeof fromCustom === "string" ? fromCustom : "";
}

function requireAuth() {
  if (!auth) throw new Error("Firebase is not configured");
  return auth;
}

export async function signInWithGoogleCredential(idToken: string): Promise<SocialSignInOutcome> {
  const cred = GoogleAuthProvider.credential(idToken);
  try {
    await signInWithCredential(requireAuth(), cred);
    return { status: "signed-in" };
  } catch (e: unknown) {
    if (isAccountExistsConflict(e)) {
      return {
        status: "needs-link",
        email: needsLinkEmail(idToken, e),
        provider: "google.com",
        pendingCredential: cred,
      };
    }
    throw e;
  }
}

function buildDisplayName(fullName?: AppleFullName | null): string {
  if (!fullName) return "";
  return [fullName.givenName, fullName.familyName]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ");
}

export async function signInWithAppleCredential(
  idToken: string,
  rawNonce: string,
  fullName?: AppleFullName | null,
  authorizationCode?: string | null,
): Promise<SocialSignInOutcome> {
  const cred = new OAuthProvider("apple.com").credential({ idToken, rawNonce });
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), cred);
  } catch (e: unknown) {
    if (isAccountExistsConflict(e)) {
      return {
        status: "needs-link",
        email: needsLinkEmail(idToken, e),
        provider: "apple.com",
        pendingCredential: cred,
      };
    }
    throw e;
  }

  // Apple returns fullName ONLY on the first authorisation, ever. Firebase is
  // written first so that a failed server call still leaves the name somewhere
  // durable to re-sync from; neither failure may block sign-in.
  const displayName = buildDisplayName(fullName);
  if (displayName && !result.user.displayName) {
    try {
      await updateProfile(result.user, { displayName });
    } catch {
      // Non-fatal: the user stays signed in.
    }
    try {
      await setDisplayName(displayName);
    } catch {
      // Non-fatal: the name survives on the Firebase profile for a later re-sync.
    }
  }

  // Non-fatal, exactly like the display-name write above: a failed capture must
  // never block sign-in. The cost of failure is deferred, not immediate — the
  // user simply cannot be revoked until they sign in again.
  if (authorizationCode) {
    try {
      await storeAppleAuthorization(authorizationCode);
    } catch {
      // Swallowed deliberately; the user stays signed in.
    }
  }
  return { status: "signed-in" };
}
