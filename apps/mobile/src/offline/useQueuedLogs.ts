import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { currentUserId } from "@/lib/api";
import { getFoodById } from "./foodCache";
import { QUEUED_LOGS_KEY } from "./queryKeys";
import { discard, list, retry, type QueuedLog } from "./queue";

export type QueuedRow = {
  id: string;
  description: string;
  /**
   * null when the food is no longer in the offline cache. `0` would be a wrong
   * number rather than an absent one, and the day total would believe it.
   */
  kcal: number | null;
  mealSlot: string;
  status: "pending" | "failed";
};

async function toRow(q: QueuedLog): Promise<QueuedRow> {
  const food = await getFoodById(q.payload.food_item_id);
  return {
    id: q.id,
    // A cached food is the normal case — it is how the item got logged
    // offline at all. The fallback only shows if the cache (a 300-entry LRU)
    // evicted it between queueing and draining.
    description: food?.name ?? "Queued item",
    kcal: food ? (food.kcal_per_100g * q.payload.quantity_grams) / 100 : null,
    mealSlot: q.payload.meal_slot,
    status: q.status,
  };
}

// The diary's `date` is the device's calendar day (app/(tabs)/diary.tsx's
// `iso()`), and the server files a log under the user's own timezone as well
// (api/internal/user/middleware.go LocFromContext). `logged_at` is a bare UTC
// instant, so its "YYYY-MM-DD" prefix is a different day from either whenever
// the device is not on UTC — which would put a late-night meal on the wrong
// page until a drain silently moved it.
const localDay = (loggedAt: string) => new Date(loggedAt).toLocaleDateString("en-CA");

async function queuedRowsFor(date: string): Promise<QueuedRow[]> {
  // The same accessor drainLogs uses, so the diary shows exactly the rows that
  // will actually be sent. The queue is one device-wide list but accounts are
  // not, and `list()` returns every item on the device: without this filter
  // one user's queued meals — and their calories — appear in another's diary.
  const ownerId = currentUserId();
  if (!ownerId) return [];

  const mine = (await list()).filter(
    (q) => q.ownerId === ownerId && localDay(q.payload.logged_at) === date,
  );
  return Promise.all(mine.map(toRow));
}

// A stable empty array, so a render before the first fetch resolves does not
// hand consumers a fresh `[]` identity every time.
const NO_ROWS: QueuedRow[] = [];

// Surfaces queued writes for `date` so the diary can show them before the
// server has them. This is the app's first optimistic rendering path.
//
// Backed by react-query rather than local state on purpose: the rows must
// vanish the moment a drain lands, or the freshly-arrived server row and the
// queued copy sit on screen together and the meal is counted twice. drainLogs
// invalidates QUEUED_LOGS_KEY after every pass, which is the whole refresh
// mechanism — there is no polling.
export function useQueuedLogs(date: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [QUEUED_LOGS_KEY, date],
    queryFn: () => queuedRowsFor(date),
  });

  // Every mutation of the queue goes through the same invalidation as a drain,
  // so there is exactly one path by which these rows refresh.
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] }),
    [qc],
  );

  const retryRow = useCallback(
    async (id: string) => {
      await retry(id);
      await invalidate();
    },
    [invalidate],
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
