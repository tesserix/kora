import { signInWithAppleCredential, signInWithGoogleCredential } from "@/auth/socialCredentials";

const mockSignInWithCredential = jest.fn();
const mockUpdateProfile = jest.fn(async (..._a: unknown[]) => {});
const appleCredential = { provider: "apple.com" };
const googleCredential = { provider: "google.com" };

jest.mock("firebase/auth", () => ({
  signInWithCredential: (...a: unknown[]) => mockSignInWithCredential(...a),
  updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
  GoogleAuthProvider: { credential: jest.fn(() => googleCredential) },
  OAuthProvider: jest.fn().mockImplementation(() => ({ credential: jest.fn(() => appleCredential) })),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

const mockSetDisplayName = jest.fn(async (..._a: unknown[]) => ({}));
const mockStoreAppleAuthorization = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("@/api/hooks", () => ({
  setDisplayName: (...a: unknown[]) => mockSetDisplayName(...a),
  storeAppleAuthorization: (...a: unknown[]) => mockStoreAppleAuthorization(...a),
}));

// A JWT whose payload is {"email":"sam@example.com"}.
const TOKEN_WITH_EMAIL =
  "aaa.eyJlbWFpbCI6InNhbUBleGFtcGxlLmNvbSJ9.bbb";

function conflict(extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("exists"), {
    code: "auth/account-exists-with-different-credential",
    ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithCredential.mockResolvedValue({ user: { displayName: null } });
  mockStoreAppleAuthorization.mockImplementation(async () => ({}));
});

describe("signInWithGoogleCredential", () => {
  it("reports signed-in on success", async () => {
    await expect(signInWithGoogleCredential("tok")).resolves.toEqual({ status: "signed-in" });
  });

  it("returns needs-link carrying the SAME credential the sign-in attempted", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithGoogleCredential(TOKEN_WITH_EMAIL);
    expect(outcome.status).toBe("needs-link");
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.provider).toBe("google.com");
    // Identity, not shape: the prompt must link the credential that collided.
    expect(outcome.pendingCredential).toBe(googleCredential);
  });

  it("reads the email from the id_token payload", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithGoogleCredential(TOKEN_WITH_EMAIL);
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.email).toBe("sam@example.com");
  });

  it("falls back to customData.email when the token is unparseable", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict({ customData: { email: "fb@example.com" } }));
    const outcome = await signInWithGoogleCredential("not-a-jwt");
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.email).toBe("fb@example.com");
  });

  it("propagates every other error rather than swallowing it into needs-link", async () => {
    const other = Object.assign(new Error("nope"), { code: "auth/network-request-failed" });
    mockSignInWithCredential.mockRejectedValue(other);
    await expect(signInWithGoogleCredential("tok")).rejects.toBe(other);
  });
});

describe("signInWithAppleCredential name capture", () => {
  it("persists a first-authorisation name to Firebase AND the server", async () => {
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada", familyName: "Lovelace" });
    expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), { displayName: "Ada Lovelace" });
    expect(mockSetDisplayName).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("writes Firebase BEFORE the server, so a failed PATCH still leaves the name recoverable", async () => {
    const order: string[] = [];
    mockUpdateProfile.mockImplementation(async () => { order.push("firebase"); });
    mockSetDisplayName.mockImplementation(async () => { order.push("server"); return {}; });
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada" });
    expect(order).toEqual(["firebase", "server"]);
  });

  it("stays signed in when the server write fails", async () => {
    mockSetDisplayName.mockRejectedValue(new Error("offline"));
    await expect(
      signInWithAppleCredential("tok", "nonce", { givenName: "Ada" }),
    ).resolves.toEqual({ status: "signed-in" });
  });

  it("does nothing when Apple returns no name", async () => {
    await signInWithAppleCredential("tok", "nonce", null);
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("does not overwrite a name the user already has", async () => {
    mockSignInWithCredential.mockResolvedValue({ user: { displayName: "Existing" } });
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada" });
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("skips a name that is only whitespace", async () => {
    await signInWithAppleCredential("tok", "nonce", { givenName: "  ", familyName: "  " });
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("returns needs-link with the Apple credential on a conflict", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithAppleCredential(TOKEN_WITH_EMAIL, "nonce", null);
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.provider).toBe("apple.com");
    expect(outcome.pendingCredential).toBe(appleCredential);
  });
});

describe("signInWithAppleCredential authorization capture", () => {
  it("forwards the authorization code to the server", async () => {
    await signInWithAppleCredential("tok", "nonce", null, "auth-code-123");
    expect(mockStoreAppleAuthorization).toHaveBeenCalledWith("auth-code-123");
  });

  it("does not call the server when Apple supplied no code", async () => {
    await signInWithAppleCredential("tok", "nonce", null, null);
    expect(mockStoreAppleAuthorization).not.toHaveBeenCalled();
  });

  it("stays signed in when the capture call fails", async () => {
    mockStoreAppleAuthorization.mockRejectedValue(new Error("offline"));
    await expect(
      signInWithAppleCredential("tok", "nonce", null, "auth-code-123"),
    ).resolves.toEqual({ status: "signed-in" });
  });

  it("does not attempt capture on a link conflict", async () => {
    mockSignInWithCredential.mockRejectedValue(
      Object.assign(new Error("exists"), {
        code: "auth/account-exists-with-different-credential",
      }),
    );
    const outcome = await signInWithAppleCredential("tok", "nonce", null, "auth-code-123");
    expect(outcome.status).toBe("needs-link");
    // No session exists yet at conflict time, so the authenticated capture
    // call would 401 — capture is skipped here, not lost: it is supplied
    // instead by LinkAccountPrompt's Apple branch (a fresh code from the link
    // itself) or, failing that, by the user's next Apple sign-in.
    expect(mockStoreAppleAuthorization).not.toHaveBeenCalled();
  });
});
