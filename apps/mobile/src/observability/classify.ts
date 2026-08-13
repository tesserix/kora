// Decides whether an error is worth a crash report.
//
// Matched on `name` rather than `instanceof`: class identity does not survive
// jest module mocks or hand-built fixtures, and a check that recognises only
// the class silently takes the wrong branch on those. src/lib/api.ts:56-58
// already learned this the hard way for NetworkError.

// Client-side faults that always indicate something is wrong.
//
const REPORTABLE_NAMES = new Set([
  "NetworkError",
  "TimeoutError",
  "ResponseParseError",
  "AuthTokenError",
]);

// Deliberate, user-driven outcomes that are not faults. Listed explicitly
// rather than merely left out of REPORTABLE_NAMES, because the fallback below
// reports every unrecognised Error — so "absent" would still mean "reported".
//
// A user cancelling (capture's Cancel, a screen unmounting mid-resolve) is the
// app doing exactly what it was told. Reporting it would let every Cancel storm
// the dashboard and bury the signal — the same failure the 4xx exclusion below
// exists to prevent.
const NEVER_REPORTABLE_NAMES = new Set(["CancelledError"]);

function isApiErrorShape(e: unknown): e is { status: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

/**
 * True when this failure should reach Crashlytics.
 *
 * 4xx is deliberately excluded. An expired session (401), a permission check
 * (403), a missing row (404) and a validation refusal (422) are the app
 * working as designed. Reporting them would let a single expired session storm
 * the dashboard and bury the signal #104 exists to surface.
 */
export function isReportable(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (isApiErrorShape(error)) return error.status >= 500;

  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && NEVER_REPORTABLE_NAMES.has(name)) return false;
  if (typeof name === "string" && REPORTABLE_NAMES.has(name)) return true;

  // An error we do not recognise is still a fault — the unknown case is
  // exactly what this feature exists to surface.
  return error instanceof Error;
}
