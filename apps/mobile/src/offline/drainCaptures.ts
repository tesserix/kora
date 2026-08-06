import type { QueryClient } from "@tanstack/react-query";
import type { Resolution } from "@/api/types";
import { apiFetchMultipart, currentUserId } from "@/lib/api";
import { buildCaptureForm, normalizeResolution } from "@/api/resolveWire";
import { deleteQueuedMedia, mediaExists, queuedMediaUri } from "./captureMedia";
import {
  discard, list, markFailed, markReview, recordAttempt, type QueuedCapture,
} from "./captureQueue";
import { append as appendLog } from "./queue";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "./queryKeys";

// A resolve that SUCCEEDED but produced no usable food. Distinct from a
// transport failure: retrying will produce the same nothing, so it is terminal.
export class CaptureUnidentifiedError extends Error {
  constructor() {
    super("I couldn't identify this one.");
    this.name = "CaptureUnidentifiedError";
  }
}

export type DrainDeps = {
  ownerId: string;
  resolve: (capture: QueuedCapture) => Promise<Resolution>;
  mediaExists: (storedName: string) => boolean;
  deleteMedia: (storedName: string) => Promise<void>;
};

// Same classifier as the log queue, for the same reasons (see queue.ts).
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}
function isPermanent(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401) return false;
  return typeof status === "number" && status >= 400 && status < 500;
}
function countsAsAttempt(err: unknown): boolean {
  return typeof statusOf(err) === "number";
}

function firstCandidate(resolution: Resolution) {
  return resolution.candidates?.[0];
}

export async function drainCaptureQueue(deps: DrainDeps) {
  let logged = 0, review = 0, failed = 0, deferred = 0;

  for (const item of await list()) {
    if (item.status !== "pending") continue;
    if (item.ownerId !== deps.ownerId) continue;

    // The file can be gone: an OS purge, cleared app data, or a crash between
    // append and copy. Terminal, and handled per item so one missing file
    // cannot strand the rest of the pass.
    if (!deps.mediaExists(item.storedName)) {
      await markFailed(item.id, "The photo or recording is no longer on this device.");
      failed++;
      continue;
    }

    try {
      const resolution = await deps.resolve(item);
      const candidate = firstCandidate(resolution);
      if (!candidate?.item) throw new CaptureUnidentifiedError();

      if (resolution.tier === "auto") {
        // Hand off. This module never calls /v1/logs — the log queue owns
        // delivery, exactly as it does for slice 1's rows.
        await appendLog(
          {
            food_item_id: candidate.item.id,
            quantity_grams: candidate.portion_grams,
            meal_slot: item.mealSlot ?? "snack",
            // Decision 2: capture time, always.
            logged_at: item.capturedAt,
            source: item.kind === "photo" ? "photo" : "voice",
          },
          item.id,
          item.ownerId,
        );
        await deps.deleteMedia(item.storedName);
        await discard(item.id);
        logged++;
      } else {
        await markReview(item.id, resolution);
        review++;
      }
    } catch (err) {
      if (err instanceof CaptureUnidentifiedError) {
        await markFailed(item.id, err.message);
        failed++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        await markFailed(item.id, message);
        failed++;
      } else {
        await recordAttempt(item.id, message, countsAsAttempt(err));
        deferred++;
      }
    }
  }
  return { logged, review, failed, deferred };
}

async function resolveCapture(capture: QueuedCapture): Promise<Resolution> {
  const path = capture.kind === "photo" ? "/v1/resolve/photo" : "/v1/resolve/voice";
  const form = buildCaptureForm({
    uri: queuedMediaUri(capture.storedName),
    name: capture.fileName,
    type: capture.mimeType,
  });
  return normalizeResolution(await apiFetchMultipart(path, form));
}

// Same in-flight guard as drainLogs: four triggers overlap on launch, and two
// passes would resolve the same capture twice — paying Gemini twice for it.
let inFlight: Promise<void> | null = null;

async function runDrain(queryClient: QueryClient): Promise<void> {
  const ownerId = currentUserId();
  if (!ownerId) return;

  const result = await drainCaptureQueue({
    ownerId,
    resolve: resolveCapture,
    mediaExists,
    deleteMedia: deleteQueuedMedia,
  });

  queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
  if (result.logged > 0) {
    // The handoff put rows in the LOG queue; its own drain sends them.
    queryClient.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
  }
}

export function drainCaptures(queryClient: QueryClient): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runDrain(queryClient).finally(() => { inFlight = null; });
  return inFlight;
}
