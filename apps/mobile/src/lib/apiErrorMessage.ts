// Onboarding (and any other form POST) previously mapped EVERY failure to
// "Please check your details and try again." — so a user whose input was
// perfectly valid was sent to re-check it while the server was down or the
// phone was offline, a loop they cannot exit by doing what they are told.
//
// Same class of defect as the sign-in catch-all that firebaseAuthMessage
// replaced; this is its API-side counterpart.
const CHECK_DETAILS = "Please check your details and try again.";
const SERVER = "Kora is having trouble right now. Please try again in a moment.";
const OFFLINE = "Couldn't reach Kora. Check your connection.";

// Deliberately duck-typed rather than `instanceof ApiError`: importing api.ts
// would drag firebase/auth into every consumer (and every consumer's tests)
// purely to format a string. ApiError sets `name = "ApiError"` and a numeric
// `status`; apiErrorMessage.test.ts pins this against the real class so the
// shape cannot drift apart from it silently.
function isApiError(e: unknown): e is { name: string; status: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

/**
 * Maps a thrown request failure to copy that names the actual cause.
 *
 * Only a 4xx the server attributes to the payload blames the user's input.
 * Anything else — 5xx, an unroutable path, an unrecognised throwable —
 * resolves to the server message, because the safe default is to NOT tell
 * someone their details are wrong when we do not know that.
 */
export function apiErrorMessage(error: unknown): string {
  // fetch rejects with a TypeError when the request never reached a server,
  // and api.ts wraps that in a NetworkError (which extends Error, NOT
  // TypeError). Matched by name rather than by importing api.ts — this module
  // is deliberately duck-typed so it stays free of that dependency.
  if (error instanceof TypeError || (error as Error)?.name === "NetworkError") return OFFLINE;
  if (isApiError(error)) {
    return error.status === 400 || error.status === 422 ? CHECK_DETAILS : SERVER;
  }
  return SERVER;
}
