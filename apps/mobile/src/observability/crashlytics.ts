import type { ReportSink } from "./reporter";

/**
 * Builds the Crashlytics-backed sink, or null when the native module is not
 * present.
 *
 * `require` rather than a static import, inside try/catch: the native module
 * is absent in Jest and in the Expo dev client, and a static import would make
 * merely loading this file throw there. Returning null is what lets the rest
 * of the app behave identically with and without Crashlytics.
 *
 * Modular API per @react-native-firebase/crashlytics v26 — the namespaced
 * `crashlytics().recordError()` form is deprecated.
 */
export function createCrashlyticsSink(): ReportSink | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-firebase/crashlytics") as {
      getCrashlytics: () => unknown;
      recordError: (c: unknown, e: Error) => void;
      setUserId: (c: unknown, id: string) => void;
      setAttributes: (c: unknown, a: Record<string, string>) => void;
    };
    if (typeof mod?.getCrashlytics !== "function") return null;

    const instance = mod.getCrashlytics();

    return {
      recordError(error, attributes) {
        // Attributes first: they must be attached to the instance before the
        // record call that snapshots them.
        mod.setAttributes(instance, attributes);
        mod.recordError(instance, error);
      },
      setUser(id) {
        // Crashlytics has no "clear user" call; empty string is its documented
        // way of dissociating, and is what a sign-out should leave behind.
        mod.setUserId(instance, id ?? "");
      },
    };
  } catch {
    // Deliberately swallowed — absence of the native module is an expected
    // state (Jest, Expo dev client), not an error worth surfacing.
    return null;
  }
}
