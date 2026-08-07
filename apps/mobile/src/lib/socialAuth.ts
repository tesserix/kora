import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { AuthCancelledError } from "@/auth/errors";

export interface AppleFullName {
  givenName?: string | null;
  familyName?: string | null;
}

let configured = false;

export function configureGoogleSignin(): void {
  if (configured) return;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  // Fail here, loudly, rather than letting signIn() reach Play Services and
  // fail with an opaque DEVELOPER_ERROR. Same precedent as isFirebaseConfigured.
  if (!webClientId) {
    throw new Error("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not configured");
  }
  GoogleSignin.configure({
    webClientId,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  });
  configured = true;
}

export async function signInWithGoogleNative(): Promise<string> {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = (await GoogleSignin.signIn()) as {
    type?: string;
    data?: { idToken?: string | null };
    idToken?: string | null;
  };
  // The SDK RESOLVES with {type:"cancelled"} rather than rejecting, so without
  // this a cancel falls through to the throw below and reaches the user as a
  // failure.
  if (result?.type === "cancelled") throw new AuthCancelledError();
  const idToken = result?.data?.idToken ?? result?.idToken;
  if (!idToken) throw new Error("Google sign-in failed: no ID token");
  return idToken;
}

const NONCE_BYTES = 32;

function randomNonce(): string {
  return Array.from(Crypto.getRandomBytes(NONCE_BYTES))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Apple's nonce handshake: Apple receives the SHA-256 HASH and embeds it in the
 * identity token; Firebase receives the RAW value and checks it hashes to what
 * the token carries. Sending the same value to both, or swapping them, produces
 * a token Firebase rejects.
 *
 * mark8ly passes an empty rawNonce because GIP verifies Apple tokens without a
 * client nonce. kora-app-e6d38 is a plain Firebase project, so that does not
 * transfer — this generates a real nonce.
 */
export async function signInWithAppleNative(): Promise<{
  idToken: string;
  rawNonce: string;
  fullName: AppleFullName | null;
}> {
  const rawNonce = randomNonce();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  let cred: AppleAuthentication.AppleAuthenticationCredential;
  try {
    cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e: unknown) {
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code === "ERR_REQUEST_CANCELED") throw new AuthCancelledError();
    throw e;
  }
  if (!cred.identityToken) throw new Error("Apple sign-in failed: no identity token");
  return { idToken: cred.identityToken, rawNonce, fullName: cred.fullName };
}
