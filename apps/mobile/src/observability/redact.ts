// Redaction for crash reports. Every value that leaves the device passes
// through here, which is the whole point: "no user content in payloads" is an
// acceptance criterion of #104, and enforcing it at N call sites is how a meal
// description eventually leaks.
//
// Pure by design — no imports from api.ts or any SDK — so the rules are
// testable without a native module.

// Matches static route segments like v1, logs, saved-meals, unread-count.
// Rejects parameter-like segments: IDs with prefixes (post-6f1b...), encoded tokens, mixed formats.
// Pattern: lowercase letters optionally followed by hyphenated word groups, then optional version digits.
const SAFE_SEGMENT = /^[a-z]+(-[a-z]+)*([0-9]+)?$/;

/**
 * Collapses identifying path segments to `:id`.
 *
 * Uses a default-deny approach: only segments matching the lowercase kebab-case
 * pattern (e.g. "v1", "logs", "saved-meals") are kept unchanged. Everything
 * else — UUIDs, numeric IDs, encoded push tokens, or any dynamic segment — is
 * replaced with `:id`.
 *
 * Two reasons, both load-bearing. A raw id leaks an identifier into a third
 * party. It also shatters grouping — a thousand distinct issues with a count
 * of one each, instead of one issue with a count of a thousand.
 *
 * The query string is dropped entirely: it can carry a search term the user
 * typed.
 */
export function templateRoute(path: string): string {
  const [withoutQuery] = path.split("?");
  return withoutQuery
    .split("/")
    .map((segment) => (segment === "" || SAFE_SEGMENT.test(segment) ? segment : ":id"))
    .join("/");
}

// Duck-typed rather than `instanceof ApiError`: importing api.ts here would
// drag firebase/auth into this module and its tests purely to read two
// fields. Same reasoning as src/lib/apiErrorMessage.ts:12-24.
function isApiErrorShape(e: unknown): e is { status: number; requestId?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number" &&
    (typeof (e as { requestId?: unknown }).requestId === "string" ||
      (e as { requestId?: unknown }).requestId === undefined)
  );
}

function errorClass(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "UnknownError";
}

/**
 * Builds the Crashlytics attribute map for an error.
 *
 * Constructed from `(class, status, route, requestId)` ONLY. The error's
 * `message` and the response body are deliberately not sources: the server can
 * echo user input, so forwarding either would defeat the redaction this module
 * exists to guarantee.
 *
 * All values are strings because Crashlytics attributes are string-only.
 */
export function buildAttributes(error: unknown, route?: string): Record<string, string> {
  const attrs: Record<string, string> = { error_class: errorClass(error) };

  if (route) attrs.route = templateRoute(route);

  if (isApiErrorShape(error)) {
    attrs.status = String(error.status);
    if (error.requestId) attrs.request_id = error.requestId;
  }

  return attrs;
}
