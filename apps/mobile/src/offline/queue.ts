import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CreateLogInput } from "@/api/hooks";

const STORAGE_KEY = "kora.logQueue";

export type QueuedLog = {
  id: string;
  payload: CreateLogInput;
  status: "pending" | "failed";
  attempts: number;
  lastError?: string;
  queuedAt: string;
  /**
   * uid of the user who wrote this log. `append` requires one, so every item
   * this branch writes has it; the field stays optional only because items
   * persisted before ownership existed do not, and those are never auto-sent.
   */
  ownerId?: string;
};

function isValid(v: unknown): v is QueuedLog {
  const q = v as QueuedLog;
  return (
    !!q && typeof q.id === "string" && typeof q.queuedAt === "string" &&
    (q.status === "pending" || q.status === "failed") &&
    typeof q.attempts === "number" && !!q.payload &&
    (q.ownerId === undefined || typeof q.ownerId === "string")
  );
}

// isQueued reports whether a create-log RESULT was a queued item at the moment
// it was produced. Both it and a server FoodLog carry an `id: string`, so
// nothing but the extra queue bookkeeping distinguishes them and `tsc` cannot
// catch a caller that treats a queued id as a server id.
//
// It answers "was this queued when it was written", NOT "is it queued now" —
// a drain between then and now sends the item and removes it, leaving a value
// that still has queue shape but no queue entry. So this is only ever safe as
// a one-way narrowing: false means definitively a server row, true means
// only "check the queue". Anything acting on the answer — Undo above all —
// must confirm with `list()` at the moment it acts. See undoLog in
// src/api/useInstantLog.ts.
export function isQueued(value: { id: string }): value is QueuedLog {
  return isValid(value);
}

// list never throws: a corrupt or missing value yields an empty queue and any
// malformed entry is dropped, so one bad record can never wedge the drain.
// Mirrors loadCustom in src/reminders/customPrefs.ts.
export async function list(): Promise<QueuedLog[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

async function save(items: QueuedLog[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

// ownerId is a required, non-nullable string: an item with no owner is one no
// drain will ever send, so the type system refuses to create one. Callers
// resolve the uid first (see src/offline/owner.ts) and fail the write outright
// if there is none.
export async function append(
  payload: CreateLogInput,
  id: string,
  ownerId: string,
): Promise<QueuedLog> {
  const item: QueuedLog = {
    id, payload, ownerId, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  };
  await save([...(await list()), item]);
  return item;
}

export async function retry(id: string): Promise<void> {
  const items = await list();
  await save(items.map((i) => (i.id === id ? { ...i, status: "pending", lastError: undefined } : i)));
}

export async function discard(id: string): Promise<void> {
  await save((await list()).filter((i) => i.id !== id));
}

// A 4xx will fail identically forever — replaying it just burns battery and
// keeps a row the user cannot resolve. Anything else (no network, a dropped
// token, a 5xx) is worth another attempt on the next drain.
//
// 401 is the one exception, for the same reason AuthTokenError is treated as
// transient: it means "not authenticated YET", not "never will be". Its usual
// cause here is a drain that raced Firebase restoring the session on cold
// start, and it self-heals the moment a token exists. api.ts already handles a
// genuinely unusable session — a 401 that survives a forced token refresh — by
// signing the user out, so a 401 reaching this classifier is never the last
// word on the session.
//
// 403 is NOT included: authenticated-but-not-permitted does not change by
// itself (api.ts force-refreshes the token only on a 401), and drain has no
// attempt ceiling, so leaving it pending would replay it on every trigger
// forever with no failed state for a retry UI to surface.
function isPermanent(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 401) return false;
  return typeof status === "number" && status >= 400 && status < 500;
}

// drain sends pending items OLDEST FIRST and sequentially, so the diary fills
// in the order the food was eaten rather than by whichever request wins a
// race. `send` and `ownerId` are both injected so this module never imports
// the API layer or Firebase.
export async function drain(
  send: (item: QueuedLog) => Promise<void>,
  ownerId: string,
): Promise<{ sent: number; failed: number; deferred: number }> {
  let sent = 0, failed = 0, deferred = 0;

  for (const item of await list()) {
    if (item.status !== "pending") continue;
    // The queue is one device-wide list; accounts are not. Replaying another
    // user's log would write their meal into this user's diary, and the server
    // would accept it — the client-minted id is unused, so CreateIdempotent
    // just inserts. An item with no owner (queued before ownership existed)
    // belongs to nobody and is skipped rather than adopted.
    if (item.ownerId !== ownerId) continue;

    try {
      await send(item);
      await discard(item.id);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = isPermanent(err);
      permanent ? failed++ : deferred++;
      const items = await list();
      await save(items.map((i) => (i.id === item.id
        ? { ...i, attempts: i.attempts + 1, lastError: message, status: permanent ? "failed" : "pending" }
        : i)));
    }
  }
  return { sent, failed, deferred };
}
