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
    // These three return PROMISES in the RNFB modular API — declaring them
    // `void` is what let a native rejection float. `unknown` covers both the
    // real promise-returning functions and any future void form.
    const mod = require("@react-native-firebase/crashlytics") as {
      getCrashlytics: () => unknown;
      recordError: (c: unknown, e: Error) => unknown;
      setUserId: (c: unknown, id: string) => unknown;
      setAttributes: (c: unknown, a: Record<string, string>) => unknown;
    };
    if (typeof mod?.getCrashlytics !== "function") return null;

    const instance = mod.getCrashlytics();

    // A native rejection must die here. reportError's try/catch only guards
    // SYNCHRONOUS throws, so a floating rejected promise escapes as an
    // unhandled rejection — and app/_layout.tsx routes unhandled rejections
    // straight back into reportError, which would call this sink again. A
    // deterministic native failure would become a self-sustaining loop rather
    // than one dropped report. Promise.resolve() makes this safe whether the
    // native function returns a promise or not.
    const settle = (result: unknown): void => {
      void Promise.resolve(result).catch(() => {
        // Deliberately swallowed — see src/lib/push.ts for this convention.
        // Failing to report must never become a failure the app has to handle.
      });
    };

    return {
      recordError(error, attributes) {
        // Attributes first: they must be attached to the instance before the
        // record call that snapshots them.
        settle(mod.setAttributes(instance, attributes));
        settle(mod.recordError(instance, error));
      },
      setUser(id) {
        // Crashlytics has no "clear user" call; empty string is its documented
        // way of dissociating, and is what a sign-out should leave behind.
        settle(mod.setUserId(instance, id ?? ""));
      },
    };
  } catch {
    // Deliberately swallowed — absence of the native module is an expected
    // state (Jest, Expo dev client), not an error worth surfacing.
    return null;
  }
}
