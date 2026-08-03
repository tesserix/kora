import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    // Mutations must FAIL, not pause.
    //
    // Before connectivity was wired into onlineManager (src/offline/
    // connectivity.ts, installed in app/_layout.tsx) this default was moot:
    // onlineManager never reported offline under React Native, so an offline
    // mutation ran, `fetch` rejected, and onError fired. Wiring it changed
    // that silently for EVERY mutation in the app — react-query's default
    // networkMode ("online") pauses them instead: isPending true forever, no
    // error, no onError, indefinitely. A water pill disabled by
    // `disabled={addWater.isPending}` never comes back; capture's resolves
    // hang in "analyzing"; a saved-meal tap does nothing at all.
    //
    // "always" restores fail-fast for the whole app, so every existing error
    // surface keeps working offline. Note this covers MUTATIONS only —
    // pausing QUERIES offline is the desirable half of that wiring and is
    // deliberately left alone (the two reads that must not pause,
    // useQueuedLogs and any other AsyncStorage-backed query, opt out locally).
    mutations: { networkMode: "always" },
  },
});
