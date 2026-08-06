import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { currentUserId } from "@/lib/api";
import { queuedMediaUri } from "./captureMedia";
import { discard, list, retry, type QueuedCapture } from "./captureQueue";
import { drainCaptures } from "./drainCaptures";
import { QUEUED_CAPTURES_KEY } from "./queryKeys";

export type QueuedCaptureRow = {
  id: string;
  kind: "photo" | "voice";
  thumbnailUri: string | null;
  capturedAt: string;
  mealSlot: string;
  status: "pending" | "review" | "failed";
  /** ALWAYS null — a capture contributes no macros until confirmed. */
  kcal: null;
};

// Same derivation as useQueuedLogs: `capturedAt` is a bare UTC instant, so its
// "YYYY-MM-DD" prefix is a different day from the device's whenever the device
// is not on UTC.
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

function toRow(c: QueuedCapture): QueuedCaptureRow {
  return {
    id: c.id,
    kind: c.kind,
    thumbnailUri: c.kind === "photo" ? queuedMediaUri(c.storedName) : null,
    capturedAt: c.capturedAt,
    mealSlot: c.mealSlot ?? "snack",
    status: c.status,
    // ALWAYS null. A pending capture has no macros; a review capture has
    // macros the user has not accepted. Day totals contain only data the
    // user accepted, or that the AI was >= 0.90 confident of — counting an
    // unconfirmed review row's macros would make the day total MOVE the
    // moment the user rejects the suggestion, which reads as a bug.
    kcal: null,
  };
}

// A stable empty array, so a render before the first fetch resolves does not
// hand consumers a fresh `[]` identity every time.
const NO_ROWS: QueuedCaptureRow[] = [];

// Surfaces queued captures for `date` so the diary can show them before a
// drain has resolved them to food. Modeled on useQueuedLogs — see that file
// for the full rationale behind the two decisions repeated here:
// `networkMode: "always"` and `ownerId` living IN the query key.
export function useQueuedCaptures(date: string) {
  const qc = useQueryClient();
  // Same accessor drainCaptures uses, so the diary shows exactly the rows a
  // drain will actually act on. It is a synchronous read of auth.currentUser,
  // so the key below is always a concrete `string | null` — never an
  // undefined key waiting on a promise.
  const ownerId = currentUserId();

  const query = useQuery({
    queryKey: [QUEUED_CAPTURES_KEY, ownerId, date],
    queryFn: async () => {
      if (!ownerId) return NO_ROWS;
      return (await list())
        .filter((c) => c.ownerId === ownerId && localDay(c.capturedAt) === date)
        .map(toRow);
    },
    // This query reads AsyncStorage, not the network. Under react-query's
    // default networkMode ("online") every refetch would be PAUSED while
    // offline — which is the only time these rows exist.
    networkMode: "always",
  });

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] }),
    [qc],
  );

  const retryRow = useCallback(
    async (id: string) => {
      await retry(id);
      await invalidate();
      // Fire-and-forget, same reasoning as useQueuedLogs.retryRow: the queue
      // is durable, so a failed pass loses nothing, and awaiting it would let
      // a drain failure surface through this call's own error path even
      // though the retry itself succeeded.
      void drainCaptures(qc).catch(() => {});
    },
    [invalidate, qc],
  );

  const discardRow = useCallback(
    async (id: string) => {
      await discard(id);
      await invalidate();
    },
    [invalidate],
  );

  return { rows: query.data ?? NO_ROWS, retryRow, discardRow };
}
