import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "./firebase";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
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
async function fetchWithRetry(
  path: string,
  buildInit: (token: string | null) => RequestInit,
): Promise<Response> {
  const user = auth?.currentUser ?? null;
  const token = user ? await user.getIdToken() : null;
  const res = await fetch(`${BASE_URL}${path}`, buildInit(token));

  if (res.status !== 401 || !user) return res;

  const refreshedToken = await user.getIdToken(true);
  const retryRes = await fetch(`${BASE_URL}${path}`, buildInit(refreshedToken));

  if (retryRes.status === 401) await signOutForExpiredSession();

  return retryRes;
}

async function throwApiError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
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
  return (await res.json()) as { data: T; meta?: Record<string, unknown> };
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
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? body;
}
