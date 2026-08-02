import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";

// Mirrors device connectivity into react-query's onlineManager so existing
// queries stop retrying pointlessly while offline, and exposes the same state
// synchronously for the write path to decide POST-vs-enqueue.
export function installConnectivity(): () => void {
  return NetInfo.addEventListener((state: NetInfoState) => {
    onlineManager.setOnline(reachable(state));
  });
}

// isInternetReachable is null while netinfo is still probing. Treat that as
// online: a false negative queues a write that would have succeeded, which
// costs the user a pending row for no reason.
function reachable(state: NetInfoState): boolean {
  return !!state.isConnected && state.isInternetReachable !== false;
}

export function isOnline(): boolean {
  return onlineManager.isOnline();
}
