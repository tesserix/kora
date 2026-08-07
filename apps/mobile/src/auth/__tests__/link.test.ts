import {
  completeLinkWithApple,
  completeLinkWithGoogle,
  completeLinkWithPassword,
  existingSignInMethods,
} from "@/auth/link";

const mockSignInWithEmailAndPassword = jest.fn();
const mockSignInWithCredential = jest.fn();
const mockLinkWithCredential = jest.fn(async (..._a: unknown[]) => ({}));
const mockFetchSignInMethods = jest.fn();
const googleCredential = { provider: "google.com" };
const appleCredential = { provider: "apple.com" };

jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...a: unknown[]) => mockSignInWithEmailAndPassword(...a),
  signInWithCredential: (...a: unknown[]) => mockSignInWithCredential(...a),
  linkWithCredential: (...a: unknown[]) => mockLinkWithCredential(...a),
  fetchSignInMethodsForEmail: (...a: unknown[]) => mockFetchSignInMethods(...a),
  GoogleAuthProvider: { credential: jest.fn(() => googleCredential) },
  OAuthProvider: jest.fn().mockImplementation(() => ({ credential: jest.fn(() => appleCredential) })),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

const reauthedUser = { uid: "u1" };
const pending = { provider: "pending.example" } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithEmailAndPassword.mockImplementation(async () => ({ user: reauthedUser }));
  mockSignInWithCredential.mockImplementation(async () => ({ user: reauthedUser }));
});

describe("completeLinkWithPassword", () => {
  it("links the PENDING credential onto the RE-AUTHED user", async () => {
    await completeLinkWithPassword("sam@example.com", "pw", pending);
    // Both arguments pinned by identity: linking the wrong credential, or
    // linking onto the wrong user, is the failure this exists to prevent.
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("re-authenticates before linking", async () => {
    const order: string[] = [];
    mockSignInWithEmailAndPassword.mockImplementation(async () => {
      order.push("reauth");
      return { user: reauthedUser };
    });
    mockLinkWithCredential.mockImplementation(async () => { order.push("link"); return {}; });
    await completeLinkWithPassword("sam@example.com", "pw", pending);
    expect(order).toEqual(["reauth", "link"]);
  });

  it("tags a re-auth failure so it is distinguishable from a link failure", async () => {
    // Firebase gives BOTH steps auth/invalid-credential. Only the tag separates
    // "wrong password" from "expired credential".
    mockSignInWithEmailAndPassword.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithPassword("sam@example.com", "bad", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
    expect(mockLinkWithCredential).not.toHaveBeenCalled();
  });

  it("leaves a LINK failure untagged, so it is not misreported as a bad password", async () => {
    mockLinkWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithPassword("sam@example.com", "pw", pending)).rejects.toMatchObject({
      code: "auth/invalid-credential",
    });
  });

  it("preserves the original error as `cause` on the tag", async () => {
    const original = { code: "auth/too-many-requests" };
    mockSignInWithEmailAndPassword.mockRejectedValue(original);
    await expect(completeLinkWithPassword("s@e.com", "pw", pending)).rejects.toMatchObject({
      cause: original,
    });
  });
});

describe("completeLinkWithGoogle", () => {
  it("re-auths with the Google credential then links the pending one", async () => {
    await completeLinkWithGoogle("g-token", pending);
    expect(mockSignInWithCredential).toHaveBeenCalledWith(expect.anything(), googleCredential);
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("tags a failed Google re-auth", async () => {
    mockSignInWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithGoogle("g-token", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
  });
});

describe("completeLinkWithApple", () => {
  it("re-auths with the Apple credential then links the pending one", async () => {
    await completeLinkWithApple("a-token", "nonce", pending);
    expect(mockSignInWithCredential).toHaveBeenCalledWith(expect.anything(), appleCredential);
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("tags a failed Apple re-auth", async () => {
    mockSignInWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithApple("a-token", "nonce", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
  });
});

describe("existingSignInMethods", () => {
  it("returns what Firebase reports", async () => {
    mockFetchSignInMethods.mockResolvedValue(["password", "google.com"]);
    await expect(existingSignInMethods("sam@example.com")).resolves.toEqual([
      "password",
      "google.com",
    ]);
  });

  it("returns [] rather than throwing when the lookup fails", async () => {
    mockFetchSignInMethods.mockRejectedValue(new Error("enumeration protection"));
    await expect(existingSignInMethods("sam@example.com")).resolves.toEqual([]);
  });
});
