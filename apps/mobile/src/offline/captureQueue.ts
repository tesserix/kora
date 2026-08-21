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

// The ceiling for every LIGHTWEIGHT arm — text and barcode both — not for text
// alone, despite the name it kept from kora#196. Neither has a byte budget:
// MAX_CAPTURES exists for megabytes of media and that rationale does not
// transfer to a short string. Still bounded rather than unlimited: an
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

// An unseen barcode scanned while offline (kora#241). Lightweight like text —
// the payload is a short digit string — so it shares MAX_TEXT_CAPTURES rather
// than the media budget. `code` is the raw scan, not a food id: nothing on this
// device knows what it is yet, which is the entire reason the row exists.
export type BarcodeCapture = QueuedCaptureBase & {
  kind: "barcode";
  code: string;
};

export type QueuedCapture = MediaCapture | TextCapture | BarcodeCapture;

// The single narrowing helper. Consumers use this rather than re-deriving
// `kind === "photo" || kind === "voice"` at each site, so adding a future
// media modality touches one predicate.
//
// It is also the capacity split (see append/restore below): "has media" is
// what MAX_CAPTURES is actually about, and phrasing the split as
// `kind === "text"` silently put kora#241's barcode arm in the megabyte
// bucket, capped alongside photos, with nothing failing to say so.
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

type AppendBarcodeInput = Pick<
  BarcodeCapture,
  "id" | "kind" | "code" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

export type AppendCaptureInput = AppendMediaInput | AppendTextInput | AppendBarcodeInput;

// Capacity is per BUCKET, not per kind. Media rows share MAX_CAPTURES because
// they share a byte budget; lightweight rows (text, barcode) share
// MAX_TEXT_CAPTURES because they have none. Counted per bucket so a queue of
// 20 photos never refuses a typed or scanned capture, and 50 lightweight rows
// never refuse a photo.
function bucketLimit(item: QueuedCapture): number {
  return hasMedia(item) ? MAX_CAPTURES : MAX_TEXT_CAPTURES;
}
function bucketUsed(items: QueuedCapture[], item: QueuedCapture): number {
  return items.filter((i) => hasMedia(i) === hasMedia(item)).length;
}

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
  // Same reasoning as text: an empty code is not a scan, and queueing one
  // would drain into a resolve the server 400s as invalid_input — a delivery
  // failure that reads to the user as if the scan itself was rejected.
  // Deliberately NOT the server's 8-14 digit pattern: a row already in the
  // queue must not be dropped by a client-side rule the queue never applied
  // when it accepted it (kora#243 — the upgrade contract).
  if (q.kind === "barcode") return typeof q.code === "string" && q.code.length > 0;
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
  // The row an identical pending scan already put in the queue, if any. Handed
  // back in place of `item` so the caller can still report "saved" without a
  // second row appearing (kora#241).
  let existing: QueuedCapture | undefined;
  await withCaptureLock(async () => {
    const items = await list();
    // Scanning the same unseen code three times offline is one intent, not
    // three meals — a barcode carries no per-scan content to distinguish them,
    // unlike two photos of the same plate. Deduped INSIDE the lock, because
    // a scanner fires repeatedly and a pre-flight check outside it could let
    // two scans both pass before either wrote.
    //
    // Pending only: a row already in review or failed is one the user can see
    // and act on, so a fresh scan of that code is a deliberate retry and gets
    // its own row. Scoped to the owner too — one account's queue must never
    // absorb another's scan.
    if (item.kind === "barcode") {
      existing = items.find(
        (i) => i.kind === "barcode" && i.code === item.code
          && i.status === "pending" && i.ownerId === item.ownerId,
      );
      if (existing) return;
    }
    if (bucketUsed(items, item) >= bucketLimit(item)) { full = true; return; }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
  return existing ?? item;
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
// the same way append is — throws if the queue filled to its limit for the
// row's bucket (MAX_CAPTURES for media, MAX_TEXT_CAPTURES for text and
// barcode), so the caller can say so.
//
// Deliberately does NOT apply append's barcode dedupe: this restores a row the
// user asked to have back, by id. Refusing it because a later scan of the same
// code is pending would make Undo silently do nothing.
export async function restore(item: QueuedCapture): Promise<void> {
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    if (items.some((i) => i.id === item.id)) return;
    if (bucketUsed(items, item) >= bucketLimit(item)) {
      full = true;
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
}
