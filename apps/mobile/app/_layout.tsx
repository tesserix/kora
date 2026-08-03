import { useEffect } from "react";
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

setupPushHandler();

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) router.replace("/config-missing");
  }, []);

  useEffect(() => installConnectivity(), []);

  useEffect(() => installDrainTriggers(queryClient), []);

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
