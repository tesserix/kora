import { isReportable } from "./classify";
import { buildAttributes } from "./redact";

export interface ReportSink {
  recordError(error: Error, attributes: Record<string, string>): void;
  setUser(id: string | null): void;
}

export interface ReportContext {
  route?: string;
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
    // The sink contract needs an Error for its stack. Anything else is
    // wrapped, preserving only the class name — never the original message,
    // which could carry user input.
    const reportable =
      error instanceof Error ? error : new Error(attributes.error_class);
    sink.recordError(reportable, attributes);
  } catch {
    // Deliberately swallowed — see above.
  }
}
