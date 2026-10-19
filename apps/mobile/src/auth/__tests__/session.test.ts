jest.unmock("@/auth/session");
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));
const mockOpenAuthSession = jest.fn();
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: (...a: unknown[]) => mockOpenAuthSession(...a) }));

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

type Session = typeof import("@/auth/session");
let session: Session;
// Re-required per test: resetModules gives session.ts a fresh mock instance.
let AsyncStorage: typeof import("@react-native-async-storage/async-storage").default;
const fetchMock = jest.fn();

beforeEach(async () => {
  jest.resetModules();
  AsyncStorage = require("@react-native-async-storage/async-storage");
  await AsyncStorage.clear();
  mockStore.clear();
  mockOpenAuthSession.mockReset();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.EXPO_PUBLIC_ZITADEL_PROJECT_ID = "394926080202442797";
  process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_IOS = "kora-ios-client";
  process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_ANDROID = "kora-android-client";
  session = require("@/auth/session");
});

function tokenResponse(body: Record<string, unknown>, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function apiResponse(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function signInAs(sub: string, expiresIn = 3600) {
  fetchMock.mockResolvedValueOnce(apiResponse(200, { data: { code: "c1" } }));
  fetchMock.mockResolvedValueOnce(
    tokenResponse({ access_token: jwt({ sub }), refresh_token: "rt-1", expires_in: expiresIn }),
  );
  await session.signInWithPassword("ann@example.com", "pw");
}

test("password sign-in goes through kora-api, then redeems the code with PKCE", async () => {
  const seen: (string | null)[] = [];
  session.onAuthChange((uid) => seen.push(uid));
  await signInAs("user-1");

  const [apiURL, apiInit] = fetchMock.mock.calls[0];
  expect(apiURL).toBe("http://localhost:8080/v1/auth/sign-in");
  const sent = JSON.parse(apiInit.body);
  expect(sent).toMatchObject({ email: "ann@example.com", password: "pw", platform: "ios" });
  expect(sent.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The verifier never leaves the device except to Zitadel's token endpoint.
  expect(apiInit.body).not.toContain("code_verifier");

  expect(fetchMock.mock.calls[1][0]).toBe("https://auth.tesserix.app/oauth/v2/token");
  const form = new URLSearchParams(fetchMock.mock.calls[1][1].body);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("c1");
  expect(form.get("redirect_uri")).toBe("com.tesserix.kora:/auth/callback");
  expect(form.get("client_id")).toBe("kora-ios-client");
  expect(form.get("code_verifier")).toBeTruthy();

  expect(session.currentUserId()).toBe("user-1");
  expect(seen).toEqual([null, "user-1"]);
  expect(JSON.parse(mockStore.get("kora.zitadel.session")!).sub).toBe("user-1");
  expect(mockOpenAuthSession).not.toHaveBeenCalled();
});

test("a refusal carries kora-api's code and wording and redeems nothing", async () => {
  fetchMock.mockResolvedValueOnce(
    apiResponse(401, { error: "invalid_credentials", message: "That email and password don't match." }),
  );
  await expect(session.signInWithPassword("ann@example.com", "nope")).rejects.toMatchObject({
    code: "invalid_credentials",
    userMessage: "That email and password don't match.",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(session.currentUserId()).toBeNull();
});

test("an authenticator code finishes a held sign-in with the first step's verifier", async () => {
  fetchMock.mockResolvedValueOnce(
    apiResponse(403, { error: "totp_required", message: "Update Kora.", challenge: "ch-1" }),
  );
  await expect(session.signInWithPassword("ann@example.com", "pw")).rejects.toMatchObject({ code: "totp_required" });
  const challenge = JSON.parse(fetchMock.mock.calls[0][1].body).code_challenge;

  fetchMock.mockResolvedValueOnce(apiResponse(200, { data: { code: "c2" } }));
  fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: jwt({ sub: "user-1" }), refresh_token: "rt", expires_in: 3600 }));
  await session.completeTOTP("123456");

  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe("http://localhost:8080/v1/auth/totp");
  expect(JSON.parse(init.body)).toEqual({ challenge: "ch-1", code: "123456" });
  // Redeemed with the verifier whose challenge the sign-in step sent.
  const verifier = new URLSearchParams(fetchMock.mock.calls[2][1].body).get("code_verifier")!;
  const digest = require("crypto").createHash("sha256").update(verifier).digest("base64url");
  expect(digest).toBe(challenge);
  expect(session.currentUserId()).toBe("user-1");

  // Spent: a second completion has nothing to finish.
  await expect(session.completeTOTP("123456")).rejects.toMatchObject({ code: "challenge_expired" });
});

test("a wrong authenticator code keeps the sign-in held; an expired one drops it", async () => {
  fetchMock.mockResolvedValueOnce(apiResponse(403, { error: "totp_required", challenge: "ch-1" }));
  await expect(session.signInWithPassword("ann@example.com", "pw")).rejects.toBeTruthy();

  fetchMock.mockResolvedValueOnce(apiResponse(400, { error: "invalid_code" }));
  await expect(session.completeTOTP("000000")).rejects.toMatchObject({ code: "invalid_code" });
  fetchMock.mockResolvedValueOnce(apiResponse(401, { error: "challenge_expired" }));
  await expect(session.completeTOTP("000000")).rejects.toMatchObject({ code: "challenge_expired" });

  fetchMock.mockClear();
  await expect(session.completeTOTP("123456")).rejects.toMatchObject({ code: "challenge_expired" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("provider sign-in goes straight to the provider and finishes through kora-api", async () => {
  fetchMock.mockResolvedValueOnce(apiResponse(200, { data: { auth_url: "https://accounts.google.com/o/oauth2/auth?x" } }));
  mockOpenAuthSession.mockResolvedValue({
    type: "success",
    url: "com.tesserix.kora:/auth/idp?id=i-1&token=t-1&user=someone-else",
  });
  fetchMock.mockResolvedValueOnce(apiResponse(200, { data: { code: "c2" } }));
  fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: jwt({ sub: "user-3" }), refresh_token: "rt", expires_in: 3600 }));

  await session.signInWithProvider("google");

  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ provider: "google" });
  expect(mockOpenAuthSession).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x", "com.tesserix.kora:/auth/idp");
  const [finishURL, finishInit] = fetchMock.mock.calls[1];
  expect(finishURL).toBe("http://localhost:8080/v1/auth/idp/finish");
  const finish = JSON.parse(finishInit.body);
  expect(finish).toMatchObject({ provider: "google", intent_id: "i-1", intent_token: "t-1", platform: "ios" });
  // The browser-carried `user` is never forwarded as an identity.
  expect(finish.user).toBeUndefined();
  expect(session.currentUserId()).toBe("user-3");
});

test("closing the provider sheet or declining there is a cancel, not an error", async () => {
  for (const result of [{ type: "cancel" }, { type: "success", url: "com.tesserix.kora:/auth/idp?id=i&error=access_denied" }]) {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(apiResponse(200, { data: { auth_url: "https://appleid.apple.com/auth" } }));
    mockOpenAuthSession.mockResolvedValueOnce(result);
    await expect(session.signInWithProvider("apple")).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});

test("account calls post to their kora-api routes", async () => {
  fetchMock.mockResolvedValue(apiResponse(202, { data: { verification_sent: true } }));
  await session.account.signUp("Ann", "ann@example.com", "pw");
  await session.account.confirmPasswordReset("ann@example.com", "ABC123", "pw2");
  expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8080/v1/auth/sign-up");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Ann", email: "ann@example.com", password: "pw" });
  expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:8080/v1/auth/password-reset/confirm");
});

test("a persisted session is restored before the first auth callback", async () => {
  await AsyncStorage.setItem("kora.installed", "1");
  mockStore.set(
    "kora.zitadel.session",
    JSON.stringify({ sub: "user-2", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
  );
  const uid = await new Promise((resolve) => session.onAuthChange(resolve));
  expect(uid).toBe("user-2");
  expect(await session.getAccessToken()).toBe("a");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a nearly expired token is refreshed once for concurrent callers", async () => {
  await signInAs("user-1", 30);
  fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: jwt({ sub: "user-1" }), refresh_token: "rt-2", expires_in: 3600 }));

  const [a, b] = await Promise.all([session.getAccessToken(), session.getAccessToken()]);

  expect(a).toBe(b);
  // Sign-in made two calls (kora-api, then the token endpoint); one refresh follows.
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const form = new URLSearchParams(fetchMock.mock.calls[2][1].body);
  expect(form.get("grant_type")).toBe("refresh_token");
  expect(form.get("refresh_token")).toBe("rt-1");
  expect(JSON.parse(mockStore.get("kora.zitadel.session")!).refreshToken).toBe("rt-2");
});

test("invalid_grant ends the session; a network failure does not", async () => {
  await signInAs("user-1");
  fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
  await expect(session.getAccessToken(true)).rejects.toThrow("Network request failed");
  expect(session.currentUserId()).toBe("user-1");

  const seen: (string | null)[] = [];
  session.onAuthChange((uid) => seen.push(uid));
  await Promise.resolve();
  fetchMock.mockResolvedValueOnce(tokenResponse({ error: "invalid_grant" }, false));
  expect(await session.getAccessToken(true)).toBeNull();
  expect(session.currentUserId()).toBeNull();
  expect(seen).toContain(null);
  expect(mockStore.has("kora.zitadel.session")).toBe(false);
});

test("Zitadel's invalid_request for a dead refresh token ends the session", async () => {
  await signInAs("user-1");
  fetchMock.mockResolvedValueOnce(
    tokenResponse({ error: "invalid_request", error_description: "Errors.User.RefreshToken.Invalid" }, false),
  );
  expect(await session.getAccessToken(true)).toBeNull();
  expect(session.currentUserId()).toBeNull();
  expect(mockStore.has("kora.zitadel.session")).toBe(false);
});

test("a fresh install drops a keychain session left by a deleted install", async () => {
  mockStore.set("kora.zitadel.session", JSON.stringify({ sub: "old", accessToken: "a", refreshToken: "r", expiresAt: 0 }));
  await session.authReady();
  expect(session.currentUserId()).toBeNull();
  expect(mockStore.has("kora.zitadel.session")).toBe(false);
});

test("an existing install keeps its session when the marker is first written", async () => {
  await AsyncStorage.setItem("kora.appearance", "dark");
  mockStore.set("kora.zitadel.session", JSON.stringify({ sub: "kept", accessToken: "a", refreshToken: "r", expiresAt: 0 }));
  await session.authReady();
  expect(session.currentUserId()).toBe("kept");
});

test("sign-out clears locally first and revokes the refresh token best-effort", async () => {
  await signInAs("user-1");
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));

  await session.signOut();

  expect(session.currentUserId()).toBeNull();
  expect(mockStore.has("kora.zitadel.session")).toBe(false);
  expect(fetchMock.mock.calls[2][0]).toBe("https://auth.tesserix.app/oauth/v2/revoke");
  expect(new URLSearchParams(fetchMock.mock.calls[2][1].body).get("token")).toBe("rt-1");
});

test("subjectOf reads sub and rejects garbage", () => {
  expect(session.subjectOf(jwt({ sub: "abc" }))).toBe("abc");
  expect(session.subjectOf("not-a-jwt")).toBeNull();
  expect(session.subjectOf(jwt({ sub: "" }))).toBeNull();
});
