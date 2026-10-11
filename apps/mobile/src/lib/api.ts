import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth } from "./firebase";
import { reportError } from "@/observability/reporter";
import { cancelAllReminders } from "@/reminders/schedule";

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

// isNetworkError is the single discriminant for "the request never reached a
// response", so the offline feature stops naming this failure two ways.
// `instanceof` is the precise check; the `name` branch is what catches a value
// whose class identity did not survive — the queue's test fixtures and fake
// server build one by hand, and a jest module mock gives a different class
// object entirely. A caller recognising only the class takes the rethrow path
// on those and loses the write. Note the real NetworkError sets `name` too, so
// the second branch alone would cover it: the first is a precise fast path,
// not the only guard.
export function isNetworkError(err: unknown): boolean {
  return err instanceof NetworkError || (err as { name?: string } | null)?.name === "NetworkError";
}

// The CALLER aborted this request on purpose (capture's Cancel, a screen
// unmounting mid-resolve). Distinct from NetworkError because nothing failed:
// there is no fault to report, nothing to retry, and nothing to queue. Folding
// it into NetworkError made every Cancel file a crash report misattributed as a
// client network fault, and made a cancel indistinguishable from a dropped
// connection at every call site that has to tell them apart. `cause` keeps the
// underlying abort reason (whatever the caller passed to abort(), or the
// engine's own AbortError) so nothing is lost.
export class CancelledError extends Error {
  constructor(cause: unknown) {
    super("Request cancelled", { cause });
    this.name = "CancelledError";
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

// A resolve that outlives the client's own deadline — distinct from
// NetworkError because the client gave up on purpose, not because transport
// failed. See REQUEST_TIMEOUT_MS below for why this exists at all.
export class TimeoutError extends Error {
  constructor() {
    super("Request timed out");
    this.name = "TimeoutError";
  }
}

// Below Istio's 30s connection cut-off on purpose. The resolve service's own
// budget reaches ~110s (photo 20s + fallback 90s, api/internal/resolve/router.go),
// so without a client deadline the app waits on a socket the gateway has
// already closed — which is why voice resolution appeared to hang rather
// than fail (see src/api/resolveWire.ts).
export const REQUEST_TIMEOUT_MS = 25_000;

// AGENT_REQUEST_TIMEOUT_MS is the deadline for routes that run the A2A agent
// chain — classify, then draft with the planner, then review with the coach.
// Three sequential model calls do not fit in 25s: a week-long plan measured
// 27s+ on device and died at the deadline, and the user was told they were
// OFFLINE. The catch-all Istio route caps each try at 30s and retries three
// times (tesserix-k8s manifests/kora-istio/virtualservice.yaml), so a slow
// plan was also re-running the whole paid chain on every retry.
//
// This only works for paths matched by that file's AI route, which holds
// perTryTimeout: 100s and does not retry — 90s sits inside it with margin.
// A path NOT on that route must keep REQUEST_TIMEOUT_MS: waiting 90s on a
// socket Envoy closes at 30s is the exact failure the constant above exists
// to prevent.
export const AGENT_REQUEST_TIMEOUT_MS = 90_000;

// Which of the two inputs aborted the composed signal below. This is tracked
// as closure state we own rather than read back off the signal, because
// AbortSignal.reason DOES NOT EXIST on this runtime: RN's global
// AbortController/AbortSignal come from the `abort-controller` npm polyfill
// (see node_modules/react-native/Libraries/Core/setUpXHR.js), whose bundled
// version (3.0.0) declares `abort(): void` and has no `reason` at all. So
// `controller.abort(someError)` silently DISCARDS its argument on device and
// `signal.reason` reads `undefined` — a discriminant routed through it is
// always undefined in production while looking perfectly correct under Jest,
// which runs on Node's native AbortController (where `reason` does exist) and
// never loads the polyfill. That mismatch is exactly how a timeout spent this
// app's entire history surfacing as a NetworkError.
//
// AbortSignal.any() is unavailable for the same reason (3.0.0 predates it
// entirely — only the TypeScript DOM lib knows about it, not this app's actual
// engine), so the caller's signal and this request's own deadline are still
// composed by hand into one controller.
type AbortCause = "caller" | "deadline";

type ComposedSignal = {
  readonly signal: AbortSignal;
  // Why the composed signal aborted, or null while it has not. Read by doFetch
  // to pick the typed error, and by abortError below.
  readonly cause: () => AbortCause | null;
  // The error this abort should surface as. Never undefined, in every case.
  readonly abortError: () => Error;
  readonly clear: () => void;
};

function composeDeadlineSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): ComposedSignal {
  const controller = new AbortController();

  // Deliberately a closure variable rather than anything read off the signal:
  // see the AbortSignal.reason note above. Written exactly once — whichever
  // input aborts first wins, and abort() on an already-aborted controller is a
  // no-op anyway, so a later abort can never relabel an earlier one.
  let cause: AbortCause | null = null;
  const abortWith = (next: AbortCause): void => {
    if (cause !== null) return;
    cause = next;
    // No argument: the polyfill drops it, and nothing here reads it back.
    controller.abort();
  };

  const timer = setTimeout(() => abortWith("deadline"), timeoutMs);

  let onCallerAbort: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      abortWith("caller");
    } else {
      onCallerAbort = () => abortWith("caller");
      callerSignal.addEventListener("abort", onCallerAbort);
    }
  }

  // The deadline aborts as TimeoutError, the caller as CancelledError — so a
  // cancel can never be mistaken for a timeout, nor either for a transport
  // failure. `reason` is read only opportunistically for CancelledError's
  // `cause`: on a runtime that supports it the caller's own reason is
  // preserved, and on this one the fallback keeps `cause` meaningful rather
  // than undefined.
  const abortError = (): Error => {
    if (cause === "deadline") return new TimeoutError();
    return new CancelledError(callerSignal?.reason ?? new Error("Aborted by the caller"));
  };

  const clear = (): void => {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);
  };

  return { signal: controller.signal, cause: () => cause, abortError, clear };
}

// Rejects when `signal` aborts, even if `promise` never settles on its own —
// required because a mocked (or simply uncooperative) fetch() that ignores
// its signal must still not hang the caller forever. Settles exactly once:
// if `promise` later resolves or rejects after an abort already won the
// race, that outcome is a no-op — a late-arriving response must never
// surface once the deadline (or a caller's own cancel) has already fired.
// `abortReason` supplies the rejection value, because `signal.reason` is
// `undefined` on this runtime (see composeDeadlineSignal) — rejecting with it
// would hand every caller an undefined error.
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal, abortReason: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason());
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
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
  // A forced sign-out is a sign-out. The user lands on /sign-in with a dead
  // session, and any meal/custom/weight reminder they configured is a LOCAL
  // scheduled notification that would otherwise keep firing there — the #171
  // symptom, reached by a path with no button and no user action behind it.
  // Inside the idempotence guard above, so a burst of concurrent 401s cancels
  // once rather than once per request. cancelAllReminders never rejects.
  await cancelAllReminders();
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

async function doFetch(path: string, init: RequestInit, composed: ComposedSignal): Promise<Response> {
  const { signal } = composed;
  try {
    return await raceWithSignal(fetch(`${BASE_URL}${path}`, { ...init, signal }), signal, composed.abortError);
  } catch (err) {
    // The deadline itself firing must surface as TimeoutError, and the
    // caller's own cancel as CancelledError — neither gets folded into the
    // generic NetworkError every genuine transport failure (offline, DNS,
    // TLS, ...) becomes below.
    if (err instanceof TimeoutError || err instanceof CancelledError) throw err;
    // fetch() sees the same abort and rejects with the ENGINE's own AbortError,
    // which can win the race against raceWithSignal's listener. That rejection
    // carries no usable identity (it is a DOMException/Error indistinguishable
    // from a transport fault), so the classification comes from the composed
    // signal's own recorded cause instead — the whole point of tracking it here
    // rather than on the signal. Without this branch an abort that lost the
    // race would still land in NetworkError.
    const cause = composed.cause();
    if (cause === "deadline") throw new TimeoutError();
    if (cause === "caller") throw new CancelledError(err);
    throw new NetworkError(err);
  }
}

// Runs one attempt (token lookup + doFetch) under its own fresh
// REQUEST_TIMEOUT_MS deadline. composeDeadlineSignal is called synchronously
// as the FIRST thing this does — before `await getToken` — so the clock
// starts the instant the attempt begins rather than after whatever async
// auth work precedes the network call. That matters for more than
// precision: a caller that races this promise against a timer (as the tests
// do) needs the deadline armed before it ever yields control back.
async function runAttempt(
  path: string,
  buildInit: (token: string | null) => RequestInit,
  callerSignal: AbortSignal | null | undefined,
  user: User | null,
  forceRefresh?: true,
  timeoutMs?: number,
): Promise<Response> {
  const composed = composeDeadlineSignal(callerSignal, timeoutMs);
  try {
    const token = user ? await getToken(user, forceRefresh) : null;
    return await doFetch(path, buildInit(token), composed);
  } finally {
    composed.clear();
  }
}

async function fetchWithRetry(
  path: string,
  buildInit: (token: string | null) => RequestInit,
  callerSignal?: AbortSignal | null,
  timeoutMs?: number,
): Promise<Response> {
  const user = auth?.currentUser ?? null;
  const res = await runAttempt(path, buildInit, callerSignal, user, undefined, timeoutMs);

  if (res.status !== 401 || !user) return res;

  // A fresh deadline for the retry, not the remainder of the first attempt's
  // — a slow-but-recovering first attempt must not leave the retry with no
  // time left to even try.
  const retryRes = await runAttempt(path, buildInit, callerSignal, user, true, timeoutMs);

  if (retryRes.status === 401) await signOutForExpiredSession();

  return retryRes;
}

// currentUserId returns the uid a request built right now would authenticate
// as, or null when there is none. fetchWithRetry attaches a Bearer token only
// when auth.currentUser exists, and with no user it also skips the
// refresh-and-retry — so an unauthenticated call comes straight back as
// ApiError(401). Background work that can simply wait (the offline log queue's
// drain, which races Firebase restoring the session on cold start) checks this
// rather than spending its payload on a 401, and the queue uses the uid to keep
// one user's logs out of another's diary on a shared device. Interactive
// requests should NOT check it: they belong to a screen that already requires a
// signed-in user.
export function currentUserId(): string | null {
  return auth?.currentUser?.uid ?? null;
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

// A 204 (and its sibling 205) is defined by HTTP to carry no body at all, so
// there is nothing for parseJson to read — calling res.json() on one throws,
// and a bodiless success would surface as a ResponseParseError. That mattered
// most where it hurt most: DELETE /v1/me answers 204, so every SUCCESSFUL
// account deletion was reported to the user as a failure. Keyed on the status
// rather than on "the body failed to parse", so a 200 whose body is genuinely
// unreadable still surfaces as ResponseParseError.
function isNoContent(res: Response): boolean {
  return res.status === 204 || res.status === 205;
}

// apiFetchEnvelope returns the whole `{ data, meta? }` envelope. PATCH
// /v1/logs/:id needs the `meta` object saying whether the correction taught
// the food index — the client must not claim "Kora will remember" for a
// best-effort write that failed — so this is the full-fidelity primitive.
export async function apiFetchEnvelope<T>(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  try {
    const res = await fetchWithRetry(
      path,
      (token) => ({
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
      init.signal,
      opts.timeoutMs,
    );

    if (!res.ok) return await throwApiError(res);
    if (isNoContent(res)) return { data: undefined as T };
    // `await` is load-bearing: a bare `return parseJson(...)` adopts the
    // promise OUTSIDE this try, so the catch below never sees a
    // ResponseParseError and the failure goes unreported.
    return await parseJson<{ data: T; meta?: Record<string, unknown> }>(res);
  } catch (err) {
    // Report EVERY failure and rethrow unchanged. This call site deliberately
    // does not decide what is worth reporting — reportError applies
    // isReportable itself, so the rule lives in exactly one place.
    reportError(err, { route: path });
    throw err;
  }
}

// apiFetch unwraps to `data` and drops everything else, which is right for
// almost every endpoint. Built on apiFetchEnvelope so auth, headers, retry,
// sign-out, and error handling live in one place. The `?? envelope`
// fallback preserves the pre-existing behaviour for bodies with no `data`
// key (or `data: null`): callers get the whole body back instead of
// `undefined`.
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const envelope = await apiFetchEnvelope<unknown>(path, init, opts);
  return envelope.data ?? envelope;
}

export async function apiFetchMultipart(
  path: string,
  form: FormData,
  // method defaults to POST so no existing caller changes. PUT is here for
  // /v1/me/avatar, which replaces a resource rather than creating one.
  init: { signal?: AbortSignal; method?: "POST" | "PUT" } = {},
): Promise<unknown> {
  try {
    const res = await fetchWithRetry(
      path,
      (token) => ({
        method: init.method ?? "POST",
        body: form,
        // No Content-Type — fetch sets multipart/form-data with the boundary.
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }),
      init.signal,
    );

    if (!res.ok) return await throwApiError(res);
    const body = await parseJson<{ data?: unknown }>(res);
    return body.data ?? body;
  } catch (err) {
    // Report EVERY failure and rethrow unchanged. This call site deliberately
    // does not decide what is worth reporting — reportError applies
    // isReportable itself, so the rule lives in exactly one place.
    reportError(err, { route: path });
    throw err;
  }
}
