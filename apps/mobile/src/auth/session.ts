// Kora's sign-in session: Zitadel hosted login (authorization code + PKCE)
// against the kora-ios / kora-android native clients, modelled on HomeChef's
// packages/mobile-shared/src/auth/zitadel.ts.
//
// The system browser owns credentials. The app keeps the access token, which
// kora-api verifies locally, and the refresh token that renews it. Everything
// that used to read Firebase's `auth` reads this module instead:
// onAuthChange for transitions, currentUserId for a synchronous snapshot, and
// getAccessToken for requests.
import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

const ISSUER = (process.env.EXPO_PUBLIC_ZITADEL_ISSUER ?? "https://auth.tesserix.app").replace(/\/$/, "");
const PROJECT_ID = process.env.EXPO_PUBLIC_ZITADEL_PROJECT_ID ?? "";
// babel inlines EXPO_PUBLIC_* only as literal member expressions, so each
// platform's client id is read by name rather than through a computed key.
const CLIENT_ID =
  (Platform.OS === "android"
    ? process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_ANDROID
    : process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_IOS) ?? "";

// Must byte-match the kora-ios / kora-android claims' redirect URIs: single
// slash after the scheme.
const REDIRECT_URI = "com.tesserix.kora:/auth/callback";

export const isAuthConfigured = PROJECT_ID !== "" && CLIENT_ID !== "";

const STORE_KEY = "kora.zitadel.session";
// AFTER_FIRST_UNLOCK so a background drain or push launch before the user has
// unlocked since boot still finds the session rather than reading null.
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

// Renew this long before expiry, so a request never leaves with a token that
// dies in flight.
const REFRESH_MARGIN_MS = 60_000;

type Session = {
  sub: string;
  accessToken: string;
  // Epoch milliseconds.
  expiresAt: number;
  refreshToken: string;
};

let session: Session | null = null;
// In-memory fallback: unsigned simulator builds have no keychain entitlement,
// so SecureStore throws. Hold the session for the process lifetime instead of
// failing sign-in, as HomeChef does.
let memoryOnly = false;
const listeners = new Set<(uid: string | null) => void>();
let ready: Promise<void> | null = null;
let refreshing: Promise<string | null> | null = null;

export class AuthSessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AuthSessionError";
  }
}

function emit(): void {
  const uid = session?.sub ?? null;
  for (const listener of [...listeners]) listener(uid);
}

async function persist(next: Session | null): Promise<void> {
  session = next;
  if (memoryOnly) return;
  try {
    if (next) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next), KEYCHAIN_OPTIONS);
    else await SecureStore.deleteItemAsync(STORE_KEY, KEYCHAIN_OPTIONS);
  } catch {
    memoryOnly = true;
  }
}

async function restore(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY, KEYCHAIN_OPTIONS);
    const parsed = raw ? (JSON.parse(raw) as Partial<Session>) : null;
    session =
      parsed?.sub && parsed.refreshToken && parsed.accessToken && typeof parsed.expiresAt === "number"
        ? (parsed as Session)
        : null;
  } catch {
    session = null;
  }
}

// authReady resolves once any persisted session has been read. Until then
// currentUserId() is null for a user who IS signed in, the same cold-start
// window Firebase's authStateReady() covered.
export function authReady(): Promise<void> {
  ready ??= restore();
  return ready;
}

// onAuthChange calls back with the signed-in subject, or null, once the
// persisted session is known and again on every sign-in and sign-out. Like
// Firebase's onAuthStateChanged it always delivers the current state first.
export function onAuthChange(listener: (uid: string | null) => void): () => void {
  listeners.add(listener);
  let live = true;
  void authReady().then(() => {
    if (live && listeners.has(listener)) listener(session?.sub ?? null);
  });
  return () => {
    live = false;
    listeners.delete(listener);
  };
}

export function currentUserId(): string | null {
  return session?.sub ?? null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64.charAt(b0 >> 2);
    out += B64.charAt(((b0 & 3) << 4) | ((b1 ?? 0) >> 4));
    if (b1 !== undefined) out += B64.charAt(((b1 & 15) << 2) | ((b2 ?? 0) >> 6));
    if (b2 !== undefined) out += B64.charAt(b2 & 63);
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

// subjectOf reads `sub` from a JWT the token endpoint just returned over TLS.
// It is not verification, which kora-api does; it only names the session.
export function subjectOf(jwt: string): string | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = globalThis.atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}

// Query params from a callback URL. Hand-rolled: Hermes' URL is partial.
export function parseCallbackParams(url: string): Record<string, string> {
  const query = (url.split("#")[0] ?? "").split("?")[1] ?? "";
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    out[key] = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
};

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const body = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${ISSUER}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new AuthSessionError(`token_${parsed.error ?? res.status}`);
  return parsed;
}

function sessionFrom(tokens: TokenResponse, previous: Session | null): Session {
  const accessToken = tokens.access_token;
  const sub = (accessToken && subjectOf(accessToken)) ?? (tokens.id_token && subjectOf(tokens.id_token));
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!accessToken || !sub || !refreshToken) throw new AuthSessionError("incomplete_token_response");
  return { sub, accessToken, refreshToken, expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000 };
}

// signIn runs the hosted-login round trip in the system browser. `register`
// opens Zitadel's registration screen instead of sign-in. Throws
// AuthSessionError("cancelled") when the user closes the browser.
export async function signIn(options: { register?: boolean } = {}): Promise<void> {
  if (!isAuthConfigured) throw new AuthSessionError("unconfigured");
  const verifier = base64Url(Crypto.getRandomBytes(32));
  const state = base64Url(Crypto.getRandomBytes(16));
  const challenge = (
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    })
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const params: Record<string, string> = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    // The project audience scope is what lets kora-api and the AI gateway
    // accept the access token: both pin aud to the Kora project.
    scope: `openid profile email offline_access urn:zitadel:iam:org:project:id:${PROJECT_ID}:aud`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (options.register) params.prompt = "create";
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  const result = await WebBrowser.openAuthSessionAsync(`${ISSUER}/oauth/v2/authorize?${qs}`, REDIRECT_URI);
  if (result.type !== "success" || !result.url) {
    throw new AuthSessionError(result.type === "cancel" || result.type === "dismiss" ? "cancelled" : "browser_failed");
  }
  const callback = parseCallbackParams(result.url);
  if (callback.error) throw new AuthSessionError(callback.error);
  if (callback.state !== state) throw new AuthSessionError("state_mismatch");
  if (!callback.code) throw new AuthSessionError("no_code");

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: callback.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  await authReady();
  await persist(sessionFrom(tokens, null));
  emit();
}

async function refresh(): Promise<string | null> {
  const current = session;
  if (!current) return null;
  try {
    const tokens = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    });
    // A sign-out while the refresh was in flight wins.
    if (session !== current) return session?.accessToken ?? null;
    await persist(sessionFrom(tokens, current));
    return session?.accessToken ?? null;
  } catch (err) {
    // invalid_grant means the refresh token is dead (revoked, expired, user
    // deleted): no retry can recover it, so the session ends. Anything else
    // (offline, 5xx) leaves it intact for the next attempt.
    if (err instanceof AuthSessionError && err.code === "token_invalid_grant" && session === current) {
      await persist(null);
      emit();
      return null;
    }
    throw err;
  }
}

// getAccessToken returns a token valid for at least REFRESH_MARGIN_MS, or null
// when nobody is signed in. `force` renews regardless, which is api.ts's
// response to a 401. Concurrent callers share one refresh, because Zitadel
// rotates the refresh token and a second use of the old one would fail.
export async function getAccessToken(force = false): Promise<string | null> {
  await authReady();
  if (!session) return null;
  if (!force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// signOut ends the session on this device and revokes the refresh token so it
// cannot be replayed. Revocation is best-effort: being offline must not keep
// someone signed in.
export async function signOut(): Promise<void> {
  await authReady();
  const ended = session;
  await persist(null);
  emit();
  if (!ended) return;
  const body = `token=${encodeURIComponent(ended.refreshToken)}&token_type_hint=refresh_token&client_id=${encodeURIComponent(CLIENT_ID)}`;
  try {
    await fetch(`${ISSUER}/oauth/v2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    // Best-effort, see above.
  }
}

// Test seam: module state survives between tests in one file.
export function __resetForTests(): void {
  session = null;
  memoryOnly = false;
  listeners.clear();
  ready = null;
  refreshing = null;
}
