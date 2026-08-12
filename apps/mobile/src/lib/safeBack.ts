import { router, type Href } from "expo-router";

// Screens reachable by deep link (notification taps, widget links, simctl
// openurl in dev) can mount with an empty navigation stack. router.back()
// there dispatches GO_BACK into nothing — a dev warning today, a dead back
// button always. Fall back to a sensible anchor instead of popping nothing.
export function safeBack(fallback: Href = "/(tabs)"): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallback);
}
