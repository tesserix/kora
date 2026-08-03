import type { QueryClient } from "@tanstack/react-query";
import { apiFetch, currentUserId } from "@/lib/api";
import { QUEUED_LOGS_KEY } from "./queryKeys";
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
  // The uid doubles as the ownership filter: drain sends only this user's logs.
  const ownerId = currentUserId();
  if (!ownerId) return;

  const result = await drain(async (item) => {
    await apiFetch("/v1/logs", {
      method: "POST",
      body: JSON.stringify({ ...item.payload, id: item.id }),
    });
  }, ownerId);

  if (result.sent > 0) {
    queryClient.invalidateQueries({ queryKey: ["logs"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  // The diary renders queued rows straight off the queue (useQueuedLogs), so
  // it has to be refreshed by every pass that got this far — not only a
  // sending one. A pass that sent removes rows the server row now replaces
  // (leave them and the user sees the meal twice, counted twice); a pass that
  // failed flips rows pending -> failed; and a pass that merely proves who is
  // signed in unblocks the owner filter for a diary that mounted during the
  // cold-start auth restore. Invalidation of a query nobody is observing is
  // free, and drains fire on real events only, so this never becomes polling.
  queryClient.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
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
