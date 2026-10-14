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
const fetchMock = jest.fn();

beforeEach(() => {
  jest.resetModules();
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

async function signInAs(sub: string, expiresIn = 3600) {
  mockOpenAuthSession.mockImplementation(async (url: string) => {
    const state = new URLSearchParams(url.split("?")[1]).get("state");
    return { type: "success", url: `com.tesserix.kora:/auth/callback?code=c1&state=${state}` };
  });
  fetchMock.mockResolvedValueOnce(
    tokenResponse({ access_token: jwt({ sub }), refresh_token: "rt-1", expires_in: expiresIn }),
  );
  await session.signIn();
}

test("sign-in requests the Kora project audience with PKCE and stores the session", async () => {
  const seen: (string | null)[] = [];
  session.onAuthChange((uid) => seen.push(uid));
  await signInAs("user-1");

  const url: string = mockOpenAuthSession.mock.calls[0][0];
  const params = new URLSearchParams(url.split("?")[1]);
  expect(params.get("scope")).toContain("urn:zitadel:iam:org:project:id:394926080202442797:aud");
  expect(params.get("scope")).toContain("offline_access");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("redirect_uri")).toBe("com.tesserix.kora:/auth/callback");
  expect(params.get("prompt")).toBeNull();

  const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code_verifier")).toBeTruthy();

  expect(session.currentUserId()).toBe("user-1");
  expect(seen).toEqual([null, "user-1"]);
  expect(JSON.parse(mockStore.get("kora.zitadel.session")!).sub).toBe("user-1");
});

test("register opens the hosted registration screen", async () => {
  mockOpenAuthSession.mockResolvedValue({ type: "cancel" });
  await expect(session.signIn({ register: true })).rejects.toMatchObject({ code: "cancelled" });
  const params = new URLSearchParams(mockOpenAuthSession.mock.calls[0][0].split("?")[1]);
  expect(params.get("prompt")).toBe("create");
});

test("a callback with the wrong state is refused", async () => {
  mockOpenAuthSession.mockResolvedValue({ type: "success", url: "com.tesserix.kora:/auth/callback?code=c&state=forged" });
  await expect(session.signIn()).rejects.toMatchObject({ code: "state_mismatch" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(session.currentUserId()).toBeNull();
});

test("a persisted session is restored before the first auth callback", async () => {
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
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const form = new URLSearchParams(fetchMock.mock.calls[1][1].body);
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

test("sign-out clears locally first and revokes the refresh token best-effort", async () => {
  await signInAs("user-1");
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));

  await session.signOut();

  expect(session.currentUserId()).toBeNull();
  expect(mockStore.has("kora.zitadel.session")).toBe(false);
  expect(fetchMock.mock.calls[1][0]).toBe("https://auth.tesserix.app/oauth/v2/revoke");
  expect(new URLSearchParams(fetchMock.mock.calls[1][1].body).get("token")).toBe("rt-1");
});

test("subjectOf reads sub and rejects garbage", () => {
  expect(session.subjectOf(jwt({ sub: "abc" }))).toBe("abc");
  expect(session.subjectOf("not-a-jwt")).toBeNull();
  expect(session.subjectOf(jwt({ sub: "" }))).toBeNull();
});
