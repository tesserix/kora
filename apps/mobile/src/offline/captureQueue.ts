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

// Text has no byte budget — MAX_CAPTURES exists for megabytes of media and
// that rationale does not transfer. Still bounded rather than unlimited: an
// abandoned-owner queue growing without limit is a known leak already recorded
// against the log queue (kora#85), and this must not add a second instance.
export const MAX_TEXT_CAPTURES = 50;

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

// Why a capture is "failed", set at the one place (drainCaptures.ts) that
// actually knows the cause — never inferred from `attempts` in the UI.
// `attempts` conflates "never delivered" (a permanent 4xx lands here with
// attempts untouched, same as an identification failure) with "delivered and
// exhausted its retries", so no threshold on attempts can separate the three
// causes; only the site that catches the error can.
export type CaptureFailureKind = "delivery" | "identification" | "missing-media";

// Fields every queued capture carries regardless of modality.
type QueuedCaptureBase = {
  id: string;
  capturedAt: string;
  mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  // Optional: a row persisted before this field existed has none, and must
  // still be accepted by isValid below rather than dropped from the queue.
  failureKind?: CaptureFailureKind;
  resolution?: Resolution;
  ownerId: string;
  queuedAt: string;
};

// A capture whose identity is a file on disk. `storedName` is the persisted
// NAME, never an absolute URI — see captureMedia.ts.
export type MediaCapture = QueuedCaptureBase & {
  kind: "photo" | "voice";
  storedName: string;
  fileName: string;
  mimeType: string;
};

// A typed capture (kora#196). No media at all, so no storage lifecycle, no
// orphan sweep, and no byte budget — which is why it gets its own ceiling
// below rather than sharing the media one.
export type TextCapture = QueuedCaptureBase & {
  kind: "text";
  phrase: string;
};

export type QueuedCapture = MediaCapture | TextCapture;

// The single narrowing helper. Consumers use this rather than re-deriving
// `kind === "photo" || kind === "voice"` at each site, so adding a future
// media modality touches one predicate.
export function hasMedia(c: QueuedCapture): c is MediaCapture {
  return c.kind === "photo" || c.kind === "voice";
}

type AppendMediaInput = Pick<
  MediaCapture,
  "id" | "kind" | "storedName" | "fileName" | "mimeType" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

type AppendTextInput = Pick<
  TextCapture,
  "id" | "kind" | "phrase" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

export type AppendCaptureInput = AppendMediaInput | AppendTextInput;

function isValid(v: unknown): v is QueuedCapture {
  const q = v as QueuedCapture;
  if (
    !q || typeof q.id !== "string" || typeof q.capturedAt !== "string" ||
    typeof q.queuedAt !== "string" || typeof q.attempts !== "number" ||
    typeof q.ownerId !== "string" ||
    !(q.status === "pending" || q.status === "review" || q.status === "failed")
  ) {
    return false;
  }
  // Per-arm. A shipped-build row carries kind "photo"/"voice" AND its media
  // fields, so it satisfies the media arm exactly as it did before the union.
  if (q.kind === "photo" || q.kind === "voice") return typeof q.storedName === "string";
  // An empty phrase is not a capture — queueing one would drain into a resolve
  // of nothing and fail as "unidentified", which reads as an AI failure rather
  // than the empty input it actually is.
  if (q.kind === "text") return typeof q.phrase === "string" && q.phrase.length > 0;
  return false;
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
  const item = {
    ...input, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  } as QueuedCapture;
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    // Counted PER ARM: a queue of 20 photos must not refuse a text capture,
    // and 50 queued phrases must not refuse a photo.
    const limit = item.kind === "text" ? MAX_TEXT_CAPTURES : MAX_CAPTURES;
    const used = items.filter((i) => (i.kind === "text") === (item.kind === "text")).length;
    if (used >= limit) { full = true; return; }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
  return item;
}

export async function markReview(id: string, resolution: Resolution): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "review", resolution, lastError: undefined } : i));
}

// `failureKind` is supplied by the caller (drainCaptures.ts), which is the
// only place that actually knows why the resolve failed — never inferred
// here, and never left for the UI to guess from `attempts`.
export async function markFailed(id: string, reason: string, failureKind: CaptureFailureKind): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "failed", lastError: reason, failureKind } : i));
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
    return {
      ...i,
      attempts,
      lastError: message,
      status: done ? "failed" : "pending",
      // Exhausting retries against a transient error is itself a delivery
      // failure — the AI never returned a verdict here either.
      ...(done ? { failureKind: "delivery" as const } : {}),
    };
  }));
}

export async function retry(id: string): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "pending", attempts: 0, lastError: undefined, failureKind: undefined } : i));
}

export async function discard(id: string): Promise<void> {
  await update((items) => items.filter((i) => i.id !== id));
}

// Puts a discarded row back exactly as it was — status, resolution, attempts
// and all. append() cannot serve as an undo: it mints a FRESH pending row and
// drops the resolution the user was looking at, so an "undo" through it would
// send the capture back for identification instead of restoring the review.
//
// Idempotent on id (a double-tapped Undo cannot duplicate the row) and capped
// the same way append is — a queue that filled while the toast was up throws
// rather than silently exceeding MAX_CAPTURES, so the caller can say so.
export async function restore(item: QueuedCapture): Promise<void> {
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    if (items.some((i) => i.id === item.id)) return;
    const limit = item.kind === "text" ? MAX_TEXT_CAPTURES : MAX_CAPTURES;
    const used = items.filter((i) => (i.kind === "text") === (item.kind === "text")).length;
    if (used >= limit) {
      full = true;
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
}
