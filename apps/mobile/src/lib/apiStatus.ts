// Duck-typed HTTP status classification, deliberately NOT `instanceof
// ApiError`: importing api.ts drags firebase/auth into every consumer and
// every consumer's test, purely to read a number. Same convention and same
// reasoning as apiErrorMessage.ts, and pinned against the real class in
// apiStatus.test.ts so the shape cannot drift apart from it silently.
function status(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { name?: unknown; status?: unknown };
  if (e.name !== "ApiError" || typeof e.status !== "number") return null;
  return e.status;
}

// isNotFound is how a screen tells "you may not see this" apart from "this
// broke". It matters wherever a 404 is a legitimate ANSWER rather than a
// failure — the cross-user reads return it for not-shared, not-a-friend,
// no-such-person and reading-yourself, deliberately indistinguishable, and
// rendering that as an error would both alarm the viewer and leak that the
// distinction exists.
export function isNotFound(error: unknown): boolean {
  return status(error) === 404;
}
