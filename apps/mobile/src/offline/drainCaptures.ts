import type { QueryClient } from "@tanstack/react-query";
import type { Resolution, ResolutionSource } from "@/api/types";
import { apiFetch, apiFetchMultipart, currentUserId } from "@/lib/api";
import { buildCaptureForm, normalizeResolution } from "@/api/resolveWire";
import { deleteQueuedMedia, mediaExists, queuedMediaUri } from "./captureMedia";
import { resolutionFromCachedFood } from "./cachedResolution";
import { getFoodByBarcode } from "./foodCache";
import {
  discard, hasMedia, list, markFailed, markReview, recordAttempt, type QueuedCapture,
} from "./captureQueue";
import { append as appendLog, newLogId } from "./queue";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "./queryKeys";
import { servingEntryFor } from "@/units/portion";

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

// Typed against ResolutionSource (src/api/types.ts) rather than a bare string
// literal, so the compiler — not a human re-reading api/internal/metrics/
// labels.go's allowlist — rejects a value the server would silently bucket
// into "other" and corrupt the by-source share metric.
//
// A switch with an exhaustive default, not a fallthrough chain: the previous
// shape returned "ai_voice" for anything that was not photo or text, so
// kora#241's barcode arm would have been logged as a voice note with nothing
// failing. `never` makes the next arm a compile error instead.
function sourceOf(kind: QueuedCapture["kind"]): ResolutionSource {
  switch (kind) {
    case "photo": return "ai_photo";
    case "text": return "ai_text";
    case "voice": return "ai_voice";
    case "barcode": return "ai_barcode";
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled capture kind: ${String(unhandled)}`);
    }
  }
}

export async function drainCaptureQueue(deps: DrainDeps) {
  let logged = 0, review = 0, failed = 0, deferred = 0;

  for (const item of await list()) {
    if (item.status !== "pending") continue;
    if (item.ownerId !== deps.ownerId) continue;

    // The file can be gone: an OS purge, cleared app data, or a crash between
    // append and copy. Terminal, and handled per item so one missing file
    // cannot strand the rest of the pass.
    // Media rows only (kora#196, kora#241). A text or barcode capture has no
    // file, so asking whether its media exists would fail it as "missing-media"
    // on the first line of the loop — reporting a lost file for a capture that
    // never had one.
    if (hasMedia(item) && !deps.mediaExists(item.storedName)) {
      await markFailed(item.id, "The photo or recording is no longer on this device.", "missing-media");
      failed++;
      continue;
    }

    try {
      const resolution = await deps.resolve(item);
      const candidate = firstCandidate(resolution);
      if (!candidate?.item) throw new CaptureUnidentifiedError();

      if (resolution.tier === "auto") {
        // Name the portion as one of the food's own servings where one fits
        // exactly, as the online path does (app/capture.tsx). Without this the
        // same photo yields "1 portion" online and "16.5 g" when it drains
        // from the offline queue.
        const serving = servingEntryFor(candidate.portion_grams, candidate.item.serving_units ?? []);
        // Hand off. This module never calls /v1/logs — the log queue owns
        // delivery, exactly as it does for slice 1's rows.
        await appendLog(
          {
            food_item_id: candidate.item.id,
            quantity_grams: candidate.portion_grams,
            ...(serving ? { entered_amount: serving.amount, entered_unit: serving.unit } : {}),
            meal_slot: item.mealSlot ?? "snack",
            // Decision 2: capture time, always.
            logged_at: item.capturedAt,
            source: sourceOf(item.kind),
          },
          // A FRESH log id, never `item.id`. The capture queue's key is
          // `cap_<millis>_<rand>`, which the server cannot bind into
          // `ID *uuid.UUID` — it 400s, the log queue calls that permanent,
          // and the row below has already deleted the media. See newLogId.
          newLogId(),
          item.ownerId,
        );
        if (hasMedia(item)) await deps.deleteMedia(item.storedName);
        await discard(item.id);
        logged++;
      } else {
        await markReview(item.id, resolution);
        review++;
      }
    } catch (err) {
      if (err instanceof CaptureUnidentifiedError) {
        await markFailed(item.id, err.message, "identification");
        failed++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        // A permanent 4xx is a DELIVERY failure — the server refused the
        // request itself, so the AI never rendered a verdict on the photo or
        // recording. Must not be classified as "identification", or
        // failureMessage() in capture-review.tsx would present a raw HTTP
        // error as if it were an AI judgment (the exact leak this field
        // exists to close).
        await markFailed(item.id, message, "delivery");
        failed++;
      } else {
        await recordAttempt(item.id, message, countsAsAttempt(err));
        deferred++;
      }
    }
  }
  return { logged, review, failed, deferred };
}

// Server first, local cache only if the request never arrived — the same order
// useResolveBarcode's withCacheFallback uses online, and deliberately not
// cache-first (kora#241 leaves this open; this is the decision).
//
// The queued row exists BECAUSE the cache had no answer, but by drain time it
// may: the user can have scanned the same product online in between, and
// useResolveBarcode caches what it resolves at "full" fidelity. Asking the
// server anyway is still right. A found barcode comes back `tier: "auto"`
// (api/internal/resolve/handler.go's barcodeCandidate) and is logged without a
// confirmation tap, whereas resolutionFromCachedFood is deliberately
// `tier: "confirm"` — so cache-first would charge the user a tap that scanning
// the same product online would not, for the same identity. A barcode resolve
// is an exact-key lookup on the server, not an AI call, so there is no COGS
// argument for skipping it either.
//
// The fallback is worth having all the same: a drain fired on a connection
// that is back but flaky would otherwise defer a row the device can answer
// exactly, and CACHED_MATCH_TIER keeps that answer honest about where it came
// from. Restricted to errors with NO http status — the request never reached
// the server. A 4xx is the server refusing this code and must stay a delivery
// failure, not be papered over with a local guess.
async function resolveQueuedBarcode(code: string): Promise<Resolution> {
  try {
    return normalizeResolution(
      await apiFetch("/v1/resolve/barcode", {
        method: "POST",
        // `barcode`, matching barcodeRequest in the handler — NOT `code`,
        // which binds to the empty string and 400s as invalid_input.
        body: JSON.stringify({ barcode: code }),
      }),
    );
  } catch (err) {
    if (statusOf(err) !== undefined) throw err;
    const cached = await getFoodByBarcode(code);
    if (!cached) throw err;
    return resolutionFromCachedFood(cached);
  }
}

async function resolveCapture(capture: QueuedCapture): Promise<Resolution> {
  // Text posts plain JSON to the same endpoint useResolveText uses; only media
  // needs the multipart body. normalizeResolution lives in the resolveWire leaf
  // module precisely so this file can use it without inverting the
  // @/api -> @/offline dependency (see that file's header).
  if (capture.kind === "text") {
    return normalizeResolution(
      await apiFetch("/v1/resolve/text", {
        method: "POST",
        body: JSON.stringify({ phrase: capture.phrase }),
      }),
    );
  }
  if (capture.kind === "barcode") return resolveQueuedBarcode(capture.code);
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
