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
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { fetchLatestWeighInDate } from "@/reminders/lastWeighIn";

setupPushHandler();

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
          .catch((err) => console.warn("reminders: foreground reconciliation failed", err));
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
