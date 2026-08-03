import type { QueryClient } from "@tanstack/react-query";
import { apiFetch, isAuthenticated } from "@/lib/api";
import { drain } from "./queue";

// Sends every pending queued log, then refreshes the views that show them.
// The id travels in the body so a replay of a write whose response was lost
// resolves to the same server row instead of a duplicate.
async function runDrain(queryClient: QueryClient): Promise<void> {
  // The cold-start trigger races Firebase restoring the session from
  // AsyncStorage, so this usually runs signed out. Sending then would go out
  // with no Authorization header and come back 401 — burning the item's one
  // clean shot for nothing. The queue is durable and installDrainTriggers
  // drains again the moment sign-in completes, so waiting costs nothing.
  if (!isAuthenticated()) return;

  const result = await drain(async (item) => {
    await apiFetch("/v1/logs", {
      method: "POST",
      body: JSON.stringify({ ...item.payload, id: item.id }),
    });
  });

  if (result.sent > 0) {
    queryClient.invalidateQueries({ queryKey: ["logs"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }
}

// Four triggers fire a drain — cold start, sign-in, reconnect and return to
// foreground (see drainTriggers) — and on launch they overlap. Two concurrent
// passes would read the same pending items and POST each of them twice, and because
// queue.drain's failure path rewrites the whole list, one pass can resurrect
// an item the other already discarded. So a drain that is already running is
// the drain: a second caller joins it instead of starting another. A joiner's
// queryClient is therefore ignored — every trigger passes the app's single
// client (src/lib/queryClient), so they are the same object anyway.
let inFlight: Promise<void> | null = null;

export function drainLogs(queryClient: QueryClient): Promise<void> {
  if (inFlight) return inFlight;
  // finally, not then: a pass that rejects must release the guard too, or the
  // queue stays wedged behind a dead promise for the rest of the session.
  inFlight = runDrain(queryClient).finally(() => { inFlight = null; });
  return inFlight;
}
