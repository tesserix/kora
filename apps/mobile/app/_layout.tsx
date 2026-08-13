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
import { AppearanceProvider } from "@/theme";
import { ToastProvider } from "@/components/Toast";
import { SavedMealSheetProvider } from "@/components/meals/SavedMealSheetProvider";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { createCrashlyticsSink } from "@/observability/crashlytics";
import { initReporting, reportError } from "@/observability/reporter";
import { ReportingUserBinder } from "@/observability/ReportingUserBinder";

setupPushHandler();

// Module scope, like setupPushHandler above: reporting must be installed
// before any component renders, or the first crash is the one we miss.
initReporting(createCrashlyticsSink());

// React Native's global handler catches what escapes every try/catch and
// every boundary. `isFatal` is not forwarded — Crashlytics distinguishes
// fatal from non-fatal itself, and the attribute map is deliberately minimal.
// The previous handler is preserved and still called: replacing it outright
// would silence RedBox in development.
const previousHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  reportError(error);
  previousHandler?.(error, isFatal);
});

// Unhandled promise rejections do NOT reach ErrorUtils. React Native tracks
// them through the `promise` polyfill's rejection-tracking module, which is
// the same mechanism Sentry's React Native SDK hooks. Without this, an async
// failure with no catch is invisible — which is precisely the #82 class of bug
// this feature exists to surface.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rejectionTracking = require("promise/setimmediate/rejection-tracking") as {
    enable: (opts: {
      allRejections: boolean;
      onUnhandled: (id: number, error: unknown) => void;
      onHandled: () => void;
    }) => void;
  };
  rejectionTracking.enable({
    allRejections: true,
    onUnhandled: (_id, error) => reportError(error),
    onHandled: () => {
      // Required by the API. A rejection handled late is not a fault.
    },
  });
} catch {
  // Deliberately swallowed — see src/lib/push.ts for this convention. If the
  // polyfill path changes in a future React Native, crash reporting must
  // degrade rather than prevent the app from starting.
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
        // No argument: this listener witnessed no weigh-in, so the reconcile
        // looks the real date up itself rather than guessing.
        void reconcileWeightReminder().catch((err) =>
          console.warn("reminders: foreground reconciliation failed", err),
        );
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ReportingUserBinder />
          <AppearanceProvider>
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
          </AppearanceProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
