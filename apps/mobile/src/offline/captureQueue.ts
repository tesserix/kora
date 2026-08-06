import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Resolution } from "@/api/types";
import { createLock } from "./lock";

const STORAGE_KEY = "kora.captureQueue";

// Its own lock, not the log queue's. The two queues have no ordering
// relationship, and sharing a chain would make a slow capture write delay a
// log drain for no reason (see lock.ts).
const withCaptureLock = createLock();

// A photo at quality 0.7 is roughly 1-3 MB, so this bounds queued media at
// well under 100 MB worst case.
export const MAX_CAPTURES = 20;

// Same ceiling and the same reasoning as the log queue's
// MAX_DELIVERY_ATTEMPTS: without one, a capture the server will never accept
// replays on every reconnect forever and the user cannot resolve it.
export const MAX_RESOLVE_ATTEMPTS = 5;

export class CaptureQueueFullError extends Error {
  constructor() {
    super("There are too many captures waiting to be identified. Connect to the internet, or remove one first.");
    this.name = "CaptureQueueFullError";
  }
}

export type QueuedCapture = {
  id: string;
  kind: "photo" | "voice";
  storedName: string;
  fileName: string;
  mimeType: string;
  capturedAt: string;
  mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  resolution?: Resolution;
  ownerId: string;
  queuedAt: string;
};

export type AppendCaptureInput = Pick<
  QueuedCapture,
  "id" | "kind" | "storedName" | "fileName" | "mimeType" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

function isValid(v: unknown): v is QueuedCapture {
  const q = v as QueuedCapture;
  return (
    !!q && typeof q.id === "string" && typeof q.storedName === "string" &&
    typeof q.capturedAt === "string" && typeof q.queuedAt === "string" &&
    (q.kind === "photo" || q.kind === "voice") &&
    (q.status === "pending" || q.status === "review" || q.status === "failed") &&
    typeof q.attempts === "number" && typeof q.ownerId === "string"
  );
}

export async function list(): Promise<QueuedCapture[]> {
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

function update(fn: (items: QueuedCapture[]) => QueuedCapture[]): Promise<void> {
  return withCaptureLock(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fn(await list())));
  });
}

export async function append(input: AppendCaptureInput): Promise<QueuedCapture> {
  const item: QueuedCapture = {
    ...input, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  };
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    if (items.length >= MAX_CAPTURES) { full = true; return; }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
  return item;
}

export async function markReview(id: string, resolution: Resolution): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "review", resolution, lastError: undefined } : i));
}

export async function markFailed(id: string, reason: string): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "failed", lastError: reason } : i));
}

// `counts` comes from the caller's verdict classifier, not from this module:
// storage does not know what an HTTP status means. attempts is read INSIDE the
// callback, not from a caller's stale snapshot, so a concurrent retry() reset
// cannot be clobbered (slice 1 review, #85).
export async function recordAttempt(id: string, message: string, counts: boolean): Promise<void> {
  await update((items) => items.map((i) => {
    if (i.id !== id) return i;
    const attempts = i.attempts + (counts ? 1 : 0);
    const done = attempts >= MAX_RESOLVE_ATTEMPTS;
    return { ...i, attempts, lastError: message, status: done ? "failed" : "pending" };
  }));
}

export async function retry(id: string): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "pending", attempts: 0, lastError: undefined } : i));
}

export async function discard(id: string): Promise<void> {
  await update((items) => items.filter((i) => i.id !== id));
}
