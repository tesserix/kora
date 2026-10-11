import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MentorCheckInAction } from "@/api/types";
import { apiFetch, currentUserId, isNetworkError, TimeoutError } from "@/lib/api";

const KEY_PREFIX = "kora.mentorCheckInOutbox.v1";
const MAX_PENDING = 200;

export type PendingMentorCheckIn = {
  commitmentId: string;
  scheduled_for: string;
  local_date: string;
  action: MentorCheckInAction;
  snoozed_until: string | null;
};

type StoredMentorCheckIn = PendingMentorCheckIn & { queued_at: string };
type FlushResult = { sent: number; pending: number };

let storageTail: Promise<void> = Promise.resolve();
let flushTail: Promise<FlushResult> = Promise.resolve({ sent: 0, pending: 0 });

function key(ownerID: string): string {
  return `${KEY_PREFIX}:${ownerID}`;
}

function occurrenceID(item: PendingMentorCheckIn): string {
  return `${item.commitmentId}:${item.scheduled_for}`;
}

function valid(item: unknown): item is StoredMentorCheckIn {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<StoredMentorCheckIn>;
  return typeof value.commitmentId === "string"
    && typeof value.scheduled_for === "string"
    && Number.isFinite(Date.parse(value.scheduled_for))
    && typeof value.local_date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value.local_date)
    && (value.action === "done" || value.action === "skipped" || value.action === "snoozed")
    && (value.snoozed_until === null || typeof value.snoozed_until === "string")
    && typeof value.queued_at === "string";
}

async function read(ownerID: string): Promise<StoredMentorCheckIn[]> {
  const raw = await AsyncStorage.getItem(key(ownerID));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function withStorage<T>(work: () => Promise<T>): Promise<T> {
  const run = storageTail.catch(() => undefined).then(work);
  storageTail = run.then(() => undefined, () => undefined);
  return run;
}

async function write(ownerID: string, items: StoredMentorCheckIn[]): Promise<void> {
  if (items.length === 0) {
    await AsyncStorage.removeItem(key(ownerID));
    return;
  }
  await AsyncStorage.setItem(key(ownerID), JSON.stringify(items));
}

export async function enqueueMentorCheckIn(item: PendingMentorCheckIn): Promise<void> {
  const ownerID = currentUserId();
  if (!ownerID) return;
  await withStorage(async () => {
    const current = await read(ownerID);
    const id = occurrenceID(item);
    const next = current.filter((entry) => occurrenceID(entry) !== id);
    next.push({ ...item, queued_at: new Date().toISOString() });
    await write(ownerID, next.slice(-MAX_PENDING));
  });
}

async function removeSent(ownerID: string, sent: StoredMentorCheckIn): Promise<void> {
  await withStorage(async () => {
    const current = await read(ownerID);
    await write(ownerID, current.filter((entry) => !(
      occurrenceID(entry) === occurrenceID(sent)
      && entry.action === sent.action
      && entry.snoozed_until === sent.snoozed_until
      && entry.queued_at === sent.queued_at
    )));
  });
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function permanent(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function send(item: PendingMentorCheckIn): Promise<void> {
  const { commitmentId, ...input } = item;
  await apiFetch(`/v1/mentor/commitments/${commitmentId}/check-ins`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

async function drain(ownerID: string): Promise<FlushResult> {
  const snapshot = await withStorage(() => read(ownerID));
  let sent = 0;
  for (const item of snapshot) {
    if (currentUserId() !== ownerID) break;
    try {
      await send(item);
      await removeSent(ownerID, item);
      sent++;
    } catch (error) {
      if (permanent(error)) {
        await removeSent(ownerID, item);
        continue;
      }
      if (isNetworkError(error) || error instanceof TimeoutError || statusOf(error) === 408 || statusOf(error) === 429 || (statusOf(error) ?? 0) >= 500) {
        break;
      }
      break;
    }
  }
  const pending = (await withStorage(() => read(ownerID))).length;
  return { sent, pending };
}

export function flushMentorCheckIns(): Promise<FlushResult> {
  const ownerID = currentUserId();
  if (!ownerID) return Promise.resolve({ sent: 0, pending: 0 });
  const run = flushTail.catch(() => ({ sent: 0, pending: 0 })).then(() => drain(ownerID));
  flushTail = run.catch(() => ({ sent: 0, pending: 0 }));
  return run;
}

export async function recordMentorCheckIn(item: PendingMentorCheckIn): Promise<void> {
  try {
    await enqueueMentorCheckIn(item);
    await flushMentorCheckIns();
  } catch {
    try {
      await send(item);
    } catch {
      // AsyncStorage and network can both be unavailable during a notification action.
    }
  }
}
