import type { ReportSink } from "./reporter";

/**
 * Builds the Sentry-backed sink, or null when Sentry is not configured.
 *
 * WHY SENTRY AND NOT CRASHLYTICS: @react-native-firebase requires
 * `useFrameworks` (SPM needs dynamic frameworks), and under frameworks
 * react-native-screens cannot import the PRIVATE React header
 * `React/RCTSurfaceTouchHandler.h` — build #16 failed on exactly that, while
 * #14/#15 had succeeded before the dependency landed. Sentry's React Native
 * SDK needs no `useFrameworks`, so it removes the whole class of problem and
 * returns the iOS build to a configuration proven to work. It also gives
 * better JS stack traces with source maps, which is what a React Native beta
 * mostly needs. See kora#104 and kora#109.
 *
 * `require` rather than a static import, inside try/catch, for the same reason
 * the Crashlytics sink did it: the native module is absent in Jest, and merely
 * loading this file must not throw there. Returning null is what lets the rest
 * of the app behave identically with and without reporting.
 *
 * A MISSING DSN IS NOT AN ERROR. It is the normal state in development and in
 * any build made before the Sentry project exists — the app runs unreported
 * rather than failing to boot. Set EXPO_PUBLIC_SENTRY_DSN to turn it on.
 */
export function createSentrySink(): ReportSink | null {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/react-native") as {
      init: (o: Record<string, unknown>) => void;
      captureException: (e: Error, hint?: Record<string, unknown>) => void;
      setUser: (u: { id: string } | null) => void;
    };
    if (typeof Sentry?.init !== "function") return null;

    Sentry.init({
      dsn,
      // Errors only. Performance tracing is a separate decision with its own
      // quota cost, and kora#104 asks for crash visibility, not APM.
      tracesSampleRate: 0,
      // The reporter layer already redacts before anything reaches a sink
      // (src/observability/redact.ts), and reporter.ts synthesizes a clean
      // Error for ApiError rather than forwarding a server message that can
      // echo user input. Default PII collection would reintroduce exactly what
      // that redaction removes.
      sendDefaultPii: false,
    });

    return {
      recordError(error, attributes) {
        // `tags` rather than `contexts`: tags are indexed and searchable in
        // Sentry, which is what makes attributes useful in triage. They are
        // already redacted strings by the time they arrive here.
        Sentry.captureException(error, { tags: attributes });
      },
      setUser(id) {
        // null clears the association, which is what a sign-out should leave
        // behind. Crashlytics needed an empty string for this; Sentry takes
        // null directly.
        Sentry.setUser(id ? { id } : null);
      },
    };
  } catch {
    // Deliberately swallowed — absence of the native module is an expected
    // state (Jest), not an error worth surfacing.
    return null;
  }
}
