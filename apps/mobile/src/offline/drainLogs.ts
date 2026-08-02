import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { drain } from "./queue";

// Sends every pending queued log, then refreshes the views that show them.
// The id travels in the body so a replay of a write whose response was lost
// resolves to the same server row instead of a duplicate.
async function runDrain(queryClient: QueryClient): Promise<void> {
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

// Three triggers fire a drain — cold start, reconnect, and return to
// foreground — and on launch they overlap. Two concurrent passes would read
// the same pending items and POST each of them twice, and because
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
