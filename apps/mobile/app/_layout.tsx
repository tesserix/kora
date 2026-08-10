import { useEffect } from "react";
import { AppState } from "react-native";
import { Stack, router } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";
import { setupPushHandler } from "@/lib/push";
import { installConnectivity } from "@/offline/connectivity";
import { installDrainTriggers } from "@/offline/drainTriggers";
import { UnitsProvider } from "@/units";
import { ToastProvider } from "@/components/Toast";
import { SavedMealSheetProvider } from "@/components/meals/SavedMealSheetProvider";
import { apiFetch } from "@/lib/api";
import type { WeightEntry } from "@/api/types";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";

setupPushHandler();

// fetchLatestWeighInDate looks back a year for the most recent weigh-in — wide
// enough to cover any real usage pattern while still bounding the query. A
// direct apiFetch, not the useWeightSeries hook: this runs from an AppState
// listener callback, not a render, so a hook cannot be called here.
//
// Never rejects. A failed fetch is treated as "no recent weigh-in" so the
// reminder still fires — per the reconciliation contract, a redundant
// reminder is a nuisance but a silently suppressed one defeats the feature.
async function fetchLatestWeighInDate(): Promise<Date | null> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const entries = (await apiFetch(
      `/v1/weight?from=${from.toISOString()}&to=${to.toISOString()}`,
    )) as WeightEntry[];
    if (entries.length === 0) return null;
    return new Date(entries[entries.length - 1].logged_at);
  } catch {
    return null;
  }
}

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) router.replace("/config-missing");
  }, []);

  useEffect(() => installConnectivity(), []);

  useEffect(() => installDrainTriggers(queryClient), []);

  // Re-arm the weight reminder's one-shot trigger on foreground: the user may
  // have weighed in (or the day may have rolled over) while the app was
  // backgrounded, and a stale trigger would either nag or stay silently
  // suppressed. Mirrors installDrainTriggers' AppState pattern.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void fetchLatestWeighInDate()
          .then(reconcileWeightReminder)
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <UnitsProvider>
          <ToastProvider>
            <SavedMealSheetProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="meal" options={{ presentation: "transparentModal", animation: "fade" }} />
                <Stack.Screen name="capture" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
              </Stack>
            </SavedMealSheetProvider>
          </ToastProvider>
        </UnitsProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
