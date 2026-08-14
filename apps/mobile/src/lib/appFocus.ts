import { AppState, Platform, type AppStateStatus } from "react-native";
import { focusManager } from "@tanstack/react-query";

// Mirrors AppState into react-query's focusManager. Without this, react-query
// uses its DOM `visibilitychange` default — which never fires under React
// Native — so it believes the app is focused forever.
//
// The cost of that belief is a real crash report, not a theoretical one (#170):
// useUnreadCount polls every 60s, the interval kept firing after iOS suspended
// the process, and a request issued moments before suspension was frozen
// mid-flight. It resolved ~20 minutes later, when a battery event woke the
// device, as `TimeoutError: Request timed out`. Google's own
// generate_204 probe timed out in the same window on the same device, which is
// what rules out a server fault.
//
// Pausing on blur is only half the fix, and the dangerous half on its own: a
// badge that resumes polling but does not REFRESH on foreground trades a noisy
// timeout for silent stale data. react-query's refetchOnWindowFocus default
// (true) supplies the other half — setFocused(true) marks every stale query for
// an immediate refetch — so this must not be paired with disabling it.
//
// Mirrors installConnectivity/installDrainTriggers: one install call from the
// root layout, one teardown function back.
export function installAppFocus(): () => void {
  const subscription = AppState.addEventListener("change", (status: AppStateStatus) => {
    // Only "active" counts as focused. iOS passes through "inactive" during the
    // app switcher, an incoming call, and Control Centre — brief, but exactly
    // the window a request must not be started in, because suspension can
    // follow without another event.
    //
    // On web, AppState is a shim and react-query's own visibilitychange
    // listener is both present and more accurate, so we leave it alone rather
    // than overriding it with a coarser signal.
    if (Platform.OS !== "web") focusManager.setFocused(status === "active");
  });

  return () => subscription.remove();
}
