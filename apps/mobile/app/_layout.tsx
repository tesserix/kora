import { useEffect } from "react";
import { AppState } from "react-native";
import { Stack, router } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";
import { setupPushHandler } from "@/lib/push";
import { installConnectivity } from "@/offline/connectivity";
import { drainLogs } from "@/offline/drainLogs";
import { UnitsProvider } from "@/units";
import { ToastProvider } from "@/components/Toast";
import { SavedMealSheetProvider } from "@/components/meals/SavedMealSheetProvider";

setupPushHandler();

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) router.replace("/config-missing");
  }, []);

  useEffect(() => installConnectivity(), []);

  useEffect(() => {
    // Fire-and-forget: the queue is durable, so a drain that fails loses
    // nothing — the items simply wait for the next trigger. drainLogs holds an
    // in-flight guard, so these three triggers overlapping on launch still
    // produce exactly one pass.
    const drain = () => { void drainLogs(queryClient).catch(() => {}); };
    // Cold start.
    drain();
    // Reconnect.
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) drain();
    });
    // Return to foreground — a drain may have been interrupted by a swipe-away.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") drain();
    });
    return () => { unsubscribe(); sub.remove(); };
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
