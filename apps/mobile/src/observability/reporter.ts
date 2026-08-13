import { isReportable } from "./classify";
import { buildAttributes } from "./redact";

export interface ReportSink {
  recordError(error: Error, attributes: Record<string, string>): void;
  setUser(id: string | null): void;
}

export interface ReportContext {
  route?: string;
}

// Duck-typed rather than `instanceof ApiError`: importing api.ts here would
// drag firebase/auth into this module and its tests purely to read two fields.
// Same reasoning as src/observability/redact.ts:37-49.
function isApiErrorShape(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

/**
 * Chooses the Error object handed to the sink.
 *
 * Crashlytics transmits `error.message` as the non-fatal's reason — it is NOT
 * attributes-only. An ApiError's message is `body.message` taken straight from
 * the server response, which can echo user input, so its Error is synthesized
 * from redacted attributes instead of forwarded. The original `.stack` is
 * carried over so triage still points at the call site.
 *
 * Every other error class (NetworkError, TimeoutError, ResponseParseError,
 * AuthTokenError, plain Error) carries one of our own static literals, which
 * is useful in triage and cannot contain user content — those are forwarded
 * unchanged.
 */
function toReportable(error: unknown, attributes: Record<string, string>): Error {
  if (isApiErrorShape(error)) {
    const synthesized = new Error(`${attributes.error_class} ${attributes.status ?? ""}`.trim());
    const stack = (error as { stack?: unknown }).stack;
    if (typeof stack === "string") synthesized.stack = stack;
    return synthesized;
  }

  // The sink contract needs an Error for its stack. Anything else is wrapped,
  // preserving only the class name — never the original message, which could
  // carry user input.
  return error instanceof Error ? error : new Error(attributes.error_class);
}

// Module-level because reporting is process-wide, like the auth session it
// shadows. Null means "no sink installed", which is the normal state in Jest
// and in the Expo dev client — the native Crashlytics module cannot load in
// either.
let sink: ReportSink | null = null;

/** Installs the sink. Pass null to disable (tests, dev client). */
export function initReporting(installed: ReportSink | null): void {
  sink = installed;
}

/**
 * Associates subsequent reports with a Kora user.
 *
 * The UUID only — never email or display name. It answers "did one user hit
 * this forty times, or forty users once?", which is usually the first question
 * a beta crash raises, without putting a human-readable identifier into a
 * third-party processor.
 */
export function setReportingUser(id: string | null): void {
  if (!sink) return;
  try {
    sink.setUser(id);
  } catch {
    // Deliberately swallowed — see src/lib/push.ts for this convention.
    // Failing to report must never become a failure the app has to handle.
  }
}

/**
 * Reports a failure, if it is worth reporting.
 *
 * Call sites report EVERY failure and never consult `isReportable` themselves.
 * Filtering lives here for the same reason redaction does: one enforcement
 * point. A call site that decides for itself is a call site that can get it
 * wrong, and "why did this failure never appear?" is the hardest kind of gap
 * to notice.
 */
export function reportError(error: unknown, context: ReportContext = {}): void {
  if (!sink) return;

  try {
    if (!isReportable(error)) return;

    const attributes = buildAttributes(error, context.route);
    sink.recordError(toReportable(error, attributes), attributes);
  } catch {
    // Deliberately swallowed — see above.
  }
}
