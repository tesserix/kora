import { AppState } from "react-native";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { drainLogs } from "./drainLogs";
import { rememberOwner } from "./owner";

// installDrainTriggers wires every moment a queued log could become sendable.
// Mirrors installConnectivity: one install call from the root layout, one
// teardown function back. drainLogs holds an in-flight guard, so triggers that
// overlap on launch still produce exactly one pass.
export function installDrainTriggers(queryClient: QueryClient): () => void {
  // Fire-and-forget: the queue is durable, so a drain that fails loses nothing
  // — the items simply wait for the next trigger.
  const drain = () => { void drainLogs(queryClient).catch(() => {}); };

  // Cold start. Usually a no-op: Firebase has not restored the session yet, and
  // drainLogs declines to send while signed out.
  drain();

  // Reconnect.
  const unsubscribeOnline = onlineManager.subscribe((online) => {
    if (online) drain();
  });

  // Return to foreground — a drain may have been interrupted by a swipe-away.
  const appStateSub = AppState.addEventListener("change", (s) => {
    if (s === "active") drain();
  });

  // Sign-in completes. This is the trigger that actually drains a queue on
  // launch, because the cold-start drain above almost always loses the race
  // against Firebase reading the persisted session out of AsyncStorage.
  // It is also the one moment the app reliably learns who the user is, so it
  // records the uid for writes that happen during the NEXT launch's restore
  // window, before live auth is available (see src/offline/owner.ts).
  const unsubscribeAuth =
    isFirebaseConfigured && auth
      ? onAuthStateChanged(auth, (user) => {
          if (!user) return;
          void rememberOwner(user.uid).catch(() => {});
          drain();
        })
      : () => {};

  return () => {
    unsubscribeOnline();
    appStateSub.remove();
    unsubscribeAuth();
  };
}
