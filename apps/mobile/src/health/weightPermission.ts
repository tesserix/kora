import { Platform } from "react-native";

import * as healthConnect from "./healthConnect";
// Lazy require, same reasoning as src/health/useHealth.ts,
// src/health/useHealthSync.ts and src/mentor/healthSync.ts:
// `@kingstinct/react-native-healthkit` is a Nitro module that throws at
// IMPORT time when the native side isn't linked (e.g. a dev client built
// before HealthKit was added). A static top-level import would crash the
// whole app before any try/catch could run.
type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");
function loadHealthKit(): HealthKitModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kingstinct/react-native-healthkit") as HealthKitModule;
}

// Declared as a bare `const` (no type annotation) so TypeScript infers the
// narrow string-literal type HealthKit's own call signatures expect, instead
// of the wide QuantityTypeIdentifier union -- the same reason useHealth.ts
// declares its identifiers this way.
export const BODY_MASS_IDENTIFIER = "HKQuantityTypeIdentifierBodyMass";

/**
 * Has the user already been shown the Health permission sheet for weight?
 *
 * This is NOT "may we read weight". Apple deliberately hides read
 * authorization status -- an app that could tell granted from denied could
 * infer the existence of data the user chose to withhold -- so
 * `getRequestStatusForAuthorization` is the only sanctioned question, and it
 * answers "would requesting show a sheet?". `unnecessary` therefore means
 * ASKED (granted or denied, indistinguishable), not GRANTED.
 *
 * That distinction is exactly what #375 needs. The gate this guards is
 * "never prompt from a background path", not "know whether reads will
 * return anything" -- a denied user simply reads nothing, which the sync
 * already handles as an empty batch.
 *
 * `unknown` (HealthKit unreachable, e.g. the entitlement is missing) is
 * treated as NOT requested: the honest answer to "has a sheet been shown" is
 * no, and returning false keeps every caller on the conservative path.
 */
export async function weightPermissionRequested(): Promise<boolean> {
  // Android answers this directly — see healthConnect.hasWeightPermission for
  // why the two platforms' different questions are interchangeable here.
  if (Platform.OS === "android") return healthConnect.hasWeightPermission();
  const healthKit = loadHealthKit();
  const status = await healthKit.getRequestStatusForAuthorization({ toRead: [BODY_MASS_IDENTIFIER] });
  return status === healthKit.AuthorizationRequestStatus.unnecessary;
}

/**
 * Show the Health permission sheet for weight reads.
 *
 * iOS shows this sheet at most once per read type for the lifetime of the
 * install: once the status is determined, `requestAuthorization` resolves
 * without any UI. Calling it on an already-determined state is therefore a
 * silent no-op, which is what makes it safe to call from a point of use
 * (opening "Log weight") on every open rather than tracking "have we asked"
 * ourselves.
 *
 * The boolean the library returns is deliberately dropped: it reports
 * whether the REQUEST completed, not whether reads were granted (see above
 * -- that answer does not exist). Callers must not treat this resolving as
 * permission to expect data.
 */
export async function requestWeightPermission(): Promise<void> {
  if (Platform.OS === "android") return healthConnect.requestWeightPermission();
  const healthKit = loadHealthKit();
  await healthKit.requestAuthorization({ toRead: [BODY_MASS_IDENTIFIER] });
}
