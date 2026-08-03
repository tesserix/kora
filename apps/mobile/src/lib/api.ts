import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth } from "./firebase";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    // The server's X-Request-Id for this response, when present — lets a
    // failure the server DID see be correlated with its log line. Absent
    // for probes and for any response that never carried the header.
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Typed failure modes ---------------------------------------------------
//
// Everything below used to surface as an anonymous thrown value, which
// collapsed three very different failures into one opaque client-side
// catch-all ("Something went wrong while I looked at that."). Each type
// preserves the original error as `cause` so nothing is lost, and callers
// (e.g. capture.tsx's ottoErrorMessage) can tell them apart with `instanceof`.

// user.getIdToken() rejected — this happens BEFORE any HTTP request is
// built, so nothing ever reached the server.
export class AuthTokenError extends Error {
  constructor(cause: unknown) {
    super("Failed to obtain an auth token", { cause });
    this.name = "AuthTokenError";
  }
}

// fetch() itself rejected — no HTTP response was ever received (offline,
// DNS failure, TLS failure, request aborted, ...).
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Network request failed", { cause });
    this.name = "NetworkError";
  }
}

// The response came back with a 2xx status, but its body did not parse as
// JSON — the server answered, but the client couldn't read the answer.
export class ResponseParseError extends Error {
  constructor(cause: unknown) {
    super("Failed to parse response body", { cause });
    this.name = "ResponseParseError";
  }
}

// --- Session-expiry recovery ---------------------------------------------
//
// A 401 can mean the cached ID token merely went stale (Firebase caches it
// until near expiry) or that the session itself is unusable server-side
// (expired session, revoked user, a token minted for a different Firebase
// project, a user row missing server-side). fetchWithRetry below forces a
// fresh token and retries once on the first 401; only a 401 that survives a
// *fresh* token is treated as an unusable session.
//
// `hasSignedOutForExpiredSession` makes the sign-out idempotent per session:
// several queries fire concurrently (e.g. the Today screen), so a rejected
// token produces a burst of 401s that would otherwise each try to sign out.
// Nothing awaits between reading and setting the flag in
// signOutForExpiredSession, so concurrent callers can't race past the guard
// — JS won't yield to another caller mid-check. The flag resets whenever a
// user signs back in, so a later session can also recover.
let hasSignedOutForExpiredSession = false;

// sessionExpiredNotice is a one-shot flag, not a general state store: it
// exists solely so the sign-in screen can tell a forced sign-out (session
// expired) apart from a manual one (Settings > Sign out) and show an
// explanation. Set right before the forced signOut call, consumed exactly
// once by whichever screen redirects next.
let sessionExpiredNotice = false;

if (auth) {
  onAuthStateChanged(auth, (user) => {
    if (user) hasSignedOutForExpiredSession = false;
  });
}

// takeSessionExpiredNotice reports (and clears) whether the most recent
// sign-out was forced by an unrecoverable 401. `(tabs)/_layout.tsx` calls
// this from its existing onAuthStateChanged guard to decide whether the
// /sign-in redirect should carry a "your session expired" explanation.
export function takeSessionExpiredNotice(): boolean {
  if (!sessionExpiredNotice) return false;
  sessionExpiredNotice = false;
  return true;
}

async function signOutForExpiredSession(): Promise<void> {
  if (hasSignedOutForExpiredSession || !auth) return;
  hasSignedOutForExpiredSession = true;
  sessionExpiredNotice = true;
  try {
    await signOut(auth);
  } catch {
    // Best-effort: if Firebase's own signOut fails, the caller still gets
    // the real 401 (ApiError) back below rather than an opaque signOut
    // failure. onAuthStateChanged not firing just means the stuck-session
    // state persists — no worse than before this fix, and never masks the
    // original error.
  }
}

// fetchWithRetry runs `buildInit` against `path`. On a 401 it retries
// exactly once with a force-refreshed ID token — the retry request never
// notices this happened if it succeeds. If the retry also comes back 401,
// the session is treated as unusable and the user is signed out so the
// existing onAuthStateChanged guard in (tabs)/_layout.tsx redirects to
// /sign-in. Any other status (403, 500, network failure surfaced as a
// thrown error, ...) is returned/thrown as-is with no sign-out — only a 401
// that survives the refresh-and-retry triggers it. With no signed-in user
// there is no token to refresh, so neither the retry nor the sign-out runs.
// getToken and doFetch exist purely to translate a rejection into the right
// typed error at the point it happens — getIdToken() failures become
// AuthTokenError, fetch() failures become NetworkError. Both are called twice
// below (initial attempt + 401 retry), so factoring the try/catch out keeps
// fetchWithRetry's control flow identical to before this change.
async function getToken(user: User, forceRefresh?: true): Promise<string> {
  try {
    // Called with no arguments (not `getIdToken(undefined)`) on the initial
    // attempt to match the pre-existing call signature exactly — some
    // callers/tests assert on arg count, not just the resolved value.
    return await (forceRefresh ? user.getIdToken(true) : user.getIdToken());
  } catch (err) {
    throw new AuthTokenError(err);
  }
}

async function doFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    throw new NetworkError(err);
  }
}

async function fetchWithRetry(
  path: string,
  buildInit: (token: string | null) => RequestInit,
): Promise<Response> {
  const user = auth?.currentUser ?? null;
  const token = user ? await getToken(user) : null;
  const res = await doFetch(path, buildInit(token));

  if (res.status !== 401 || !user) return res;

  const refreshedToken = await getToken(user, true);
  const retryRes = await doFetch(path, buildInit(refreshedToken));

  if (retryRes.status === 401) await signOutForExpiredSession();

  return retryRes;
}

// isAuthenticated reports whether a request built right now would carry a
// Bearer token. fetchWithRetry attaches one only when auth.currentUser exists,
// and with no user it also skips the refresh-and-retry — so an unauthenticated
// call comes straight back as ApiError(401). Background work that can simply
// wait (the offline log queue's drain, which races Firebase restoring the
// session on cold start) should check this rather than spend its payload on a
// 401. Interactive requests should NOT: they belong to a screen that already
// requires a signed-in user.
export function isAuthenticated(): boolean {
  return !!auth?.currentUser;
}

async function throwApiError(res: Response): Promise<never> {
  const requestId = res.headers?.get?.("X-Request-Id") ?? undefined;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed", requestId);
}

// A 2xx response whose body will not parse as JSON means the server
// answered but the client couldn't read the answer — distinct from both an
// HTTP error status (ApiError, above) and a request that never got a
// response at all (NetworkError).
async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ResponseParseError(err);
  }
}

// apiFetchEnvelope returns the whole `{ data, meta? }` envelope. PATCH
// /v1/logs/:id needs the `meta` object saying whether the correction taught
// the food index — the client must not claim "Kora will remember" for a
// best-effort write that failed — so this is the full-fidelity primitive.
export async function apiFetchEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const res = await fetchWithRetry(path, (token) => ({
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  }));

  if (!res.ok) return throwApiError(res);
  return parseJson<{ data: T; meta?: Record<string, unknown> }>(res);
}

// apiFetch unwraps to `data` and drops everything else, which is right for
// almost every endpoint. Built on apiFetchEnvelope so auth, headers, retry,
// sign-out, and error handling live in one place. The `?? envelope`
// fallback preserves the pre-existing behaviour for bodies with no `data`
// key (or `data: null`): callers get the whole body back instead of
// `undefined`.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const envelope = await apiFetchEnvelope<unknown>(path, init);
  return envelope.data ?? envelope;
}

export async function apiFetchMultipart(path: string, form: FormData): Promise<unknown> {
  const res = await fetchWithRetry(path, (token) => ({
    method: "POST",
    body: form,
    // No Content-Type — fetch sets multipart/form-data with the boundary.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }));

  if (!res.ok) return throwApiError(res);
  const body = await parseJson<{ data?: unknown }>(res);
  return body.data ?? body;
}
