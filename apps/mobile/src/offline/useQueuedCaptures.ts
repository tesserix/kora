import { useQuery } from "@tanstack/react-query";
import { currentUserId } from "@/lib/api";
import { queuedMediaUri } from "./captureMedia";
import { list, type QueuedCapture } from "./captureQueue";
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

  // Rows only, deliberately.
  //
  // This hook used to also return `retryRow`/`discardRow`, mirroring
  // useQueuedLogs. Neither was ever wired: diary.tsx's QueuedFailedSheet is
  // driven by the LOG queue's handlers, and task 8 rerouted a failed capture
  // to /capture-review, which owns Retry, Discard and manual logging itself
  // (and, unlike the deleted `discardRow`, deletes the media alongside the
  // row — that handler was the one row-removal path on this branch that
  // leaked its file). Dead code with a data-loss bug in it is worse than no
  // code, so it is gone rather than fixed; re-add it only with a caller.
  return { rows: query.data ?? NO_ROWS };
}
