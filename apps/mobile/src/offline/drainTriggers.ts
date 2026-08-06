import { AppState } from "react-native";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { sweepOrphans } from "./captureMedia";
import { list as listCaptures } from "./captureQueue";
import { drainCaptures } from "./drainCaptures";
import { drainLogs } from "./drainLogs";
import { forgetOwner, rememberOwner } from "./owner";

// installDrainTriggers wires every moment a queued log or capture could
// become sendable. Mirrors installConnectivity: one install call from the
// root layout, one teardown function back. drainLogs and drainCaptures each
// hold their own in-flight guard, so triggers that overlap on launch still
// produce exactly one pass per queue.
export function installDrainTriggers(queryClient: QueryClient): () => void {
  // Fire-and-forget: both queues are durable, so a drain that fails loses
  // nothing — the items simply wait for the next trigger.
  const drain = () => {
    void drainLogs(queryClient).catch(() => {});
    void drainCaptures(queryClient).catch(() => {});
  };

  // Cold start. Usually a no-op: Firebase has not restored the session yet, and
  // drainLogs/drainCaptures decline to send while signed out.
  drain();

  // Reclaim media left behind by a crash between the copy and the append. Runs
  // once per launch; a failure is ignored because the next launch retries.
  void listCaptures()
    .then((items) => sweepOrphans(items.map((i) => i.storedName)))
    .catch(() => {});

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
          if (!user) {
            void forgetOwner().catch(() => {});
            return;
          }
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
