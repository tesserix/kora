import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { apiFetch } from "@/lib/api";
import { resolveAuthState } from "@/lib/authState";
import { readAnchor, writeAnchor } from "./anchorStore";
import { syncWeight, type WeightRecord, type WeightSample, type WeightSyncResponse } from "./syncWeight";

// Lazy require, same reasoning as src/health/useHealth.ts and
// src/mentor/healthSync.ts: `@kingstinct/react-native-healthkit` is a Nitro
// module that throws at IMPORT time when the native side isn't linked (e.g.
// a dev client built before HealthKit was added). A static top-level import
// would crash the whole app before any try/catch could run.
type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");
function loadHealthKit(): HealthKitModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kingstinct/react-native-healthkit") as HealthKitModule;
}

const BODY_MASS_IDENTIFIER = "HKQuantityTypeIdentifierBodyMass";

// Throwing (rather than returning an empty batch) when HealthKit is
// unreachable or unauthorized matters: syncWeight only advances the anchor
// after `queryWeights` succeeds, so a throw here leaves the anchor untouched
// and the next launch tries again -- the same self-healing behaviour as a
// failed post.
async function queryWeights(anchor: string | null): Promise<{ samples: WeightSample[]; newAnchor: string }> {
  const healthKit = loadHealthKit();
  if (!healthKit.isHealthDataAvailable()) throw new Error("HealthKit unavailable");
  if (!await healthKit.requestAuthorization({ toRead: [BODY_MASS_IDENTIFIER] })) {
    throw new Error("HealthKit authorization denied");
  }

  const response = await healthKit.queryQuantitySamplesWithAnchor(BODY_MASS_IDENTIFIER, {
    limit: 0,
    unit: "kg",
    anchor: anchor ?? undefined,
  });

  return {
    samples: response.samples.map((s) => ({
      uuid: s.uuid,
      quantity: s.quantity,
      startDate: s.startDate,
      sourceName: s.sourceRevision.source.name,
    })),
    newAnchor: response.newAnchor,
  };
}

async function post(weights: WeightRecord[]): Promise<WeightSyncResponse> {
  return apiFetch("/v1/health/sync", {
    method: "POST",
    body: JSON.stringify({ weights }),
  }) as Promise<WeightSyncResponse>;
}

// The auth gate. Mirrors src/reminders/reconcileWeightReminder.ts (#171): a
// sync kicked off while signed out has no user to post to and no token to
// post with, so apiFetch would just fail every call -- but only after
// resolveAuthState's authStateReady() await, which loses the race against
// this hook's own mount-time run on a cold start far more often than not, so
// skipping outright here is not merely tidier than letting it fail, it is
// the only way most signed-out launches actually skip the attempt.
async function run(): Promise<void> {
  if (Platform.OS !== "ios") return;
  const authState = await resolveAuthState();
  if (authState !== "signed-in") return;
  await syncWeight({ queryWeights, post, readAnchor, writeAnchor });
}

// Runs the weight sync on mount and every time the app returns to the
// foreground -- the two moments new HealthKit samples (written by the Health
// app, a paired scale, or a third-party app) are most likely to be waiting.
// Errors are swallowed deliberately: syncWeight already leaves the anchor
// untouched on any failure, so the next launch or foreground simply retries
// the same window. Surfacing a modal for a background sync the user didn't
// initiate would be worse than silence.
export function useHealthSync(): void {
  useEffect(() => {
    void run().catch(() => {});
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void run().catch(() => {});
    });
    return () => subscription.remove();
  }, []);
}
