import * as Crypto from "expo-crypto";
import * as AppleAuthentication from "expo-apple-authentication";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { AuthCancelledError } from "@/auth/errors";
import { configureGoogleSignin, signInWithAppleNative, signInWithGoogleNative } from "@/lib/socialAuth";

jest.mock("expo-apple-authentication", () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(async () => true), signIn: jest.fn() },
}));

const signInAsync = AppleAuthentication.signInAsync as jest.Mock;
const googleSignIn = GoogleSignin.signIn as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "web-client-id";
});

describe("signInWithAppleNative", () => {
  it("sends the SHA-256 HASH to Apple and returns the RAW nonce for Firebase", async () => {
    // Both values are strings, so swapping them is the plausible bug and would
    // survive a weaker assertion. Pin each to the side it belongs on.
    jest.spyOn(Crypto, "digestStringAsync").mockResolvedValue("HASHED_NONCE");
    signInAsync.mockResolvedValue({ identityToken: "apple-id-token", fullName: null });

    const result = await signInWithAppleNative();

    const sentNonce = signInAsync.mock.calls[0][0].nonce;
    expect(sentNonce).toBe("HASHED_NONCE");
    expect(result.rawNonce).not.toBe("HASHED_NONCE");
    expect(result.rawNonce.length).toBeGreaterThan(0);
    // The hash must be OF the raw nonce, not of something else.
    expect(Crypto.digestStringAsync).toHaveBeenCalledWith(
      Crypto.CryptoDigestAlgorithm.SHA256,
      result.rawNonce,
    );
    expect(result.idToken).toBe("apple-id-token");
  });

  it("never reuses a nonce between calls", async () => {
    signInAsync.mockResolvedValue({ identityToken: "t", fullName: null });
    const a = await signInWithAppleNative();
    const b = await signInWithAppleNative();
    expect(a.rawNonce).not.toBe(b.rawNonce);
  });

  it("requests FULL_NAME and EMAIL scopes so a first authorisation returns a name", async () => {
    signInAsync.mockResolvedValue({ identityToken: "t", fullName: null });
    await signInWithAppleNative();
    expect(signInAsync.mock.calls[0][0].requestedScopes).toEqual([
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ]);
  });

  it("passes the fullName through untouched", async () => {
    signInAsync.mockResolvedValue({
      identityToken: "t",
      fullName: { givenName: "Ada", familyName: "Lovelace" },
    });
    const result = await signInWithAppleNative();
    expect(result.fullName).toEqual({ givenName: "Ada", familyName: "Lovelace" });
  });

  it("normalises Apple's cancellation to AuthCancelledError", async () => {
    signInAsync.mockRejectedValue({ code: "ERR_REQUEST_CANCELED" });
    await expect(signInWithAppleNative()).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("propagates a non-cancellation Apple error unchanged", async () => {
    const boom = { code: "ERR_REQUEST_UNKNOWN" };
    signInAsync.mockRejectedValue(boom);
    await expect(signInWithAppleNative()).rejects.toBe(boom);
  });

  it("throws when Apple returns no identity token", async () => {
    signInAsync.mockResolvedValue({ identityToken: null, fullName: null });
    await expect(signInWithAppleNative()).rejects.toThrow("no identity token");
  });

  it("returns the authorizationCode Apple supplied", async () => {
    signInAsync.mockResolvedValue({
      identityToken: "t",
      authorizationCode: "auth-code-123",
      fullName: null,
    });
    const result = await signInWithAppleNative();
    // Apple returns this ONLY at sign-in; dropping it here makes the user
    // permanently unrevokable.
    expect(result.authorizationCode).toBe("auth-code-123");
  });

  it("tolerates Apple omitting the authorizationCode", async () => {
    signInAsync.mockResolvedValue({ identityToken: "t", fullName: null });
    const result = await signInWithAppleNative();
    expect(result.authorizationCode).toBeNull();
    // Sign-in must still succeed — the token is a nice-to-have at this point.
    expect(result.idToken).toBe("t");
  });
});

describe("signInWithGoogleNative", () => {
  it("returns the ID token from the nested data shape", async () => {
    googleSignIn.mockResolvedValue({ type: "success", data: { idToken: "google-id-token" } });
    await expect(signInWithGoogleNative()).resolves.toBe("google-id-token");
  });

  it("checks Play Services before signing in", async () => {
    googleSignIn.mockResolvedValue({ data: { idToken: "t" } });
    await signInWithGoogleNative();
    expect(GoogleSignin.hasPlayServices).toHaveBeenCalled();
  });

  // The SDK RESOLVES on cancel rather than rejecting. Untreated, this falls
  // through to the "no ID token" throw and is shown to the user as a failure.
  it("treats a RESOLVED cancellation as AuthCancelledError, not a failure", async () => {
    googleSignIn.mockResolvedValue({ type: "cancelled", data: null });
    await expect(signInWithGoogleNative()).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("throws when the SDK succeeds but yields no ID token", async () => {
    googleSignIn.mockResolvedValue({ type: "success", data: { idToken: null } });
    await expect(signInWithGoogleNative()).rejects.toThrow("no ID token");
  });
});

describe("configureGoogleSignin", () => {
  it("fails loudly when the web client id is missing", () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    expect(() => configureGoogleSignin()).toThrow("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID");
    expect(GoogleSignin.configure).not.toHaveBeenCalled();
  });
});
