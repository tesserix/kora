import { copyIntoQueue, deleteQueuedMedia } from "./captureMedia";
import { append, type BarcodeCapture, type QueuedCapture, type TextCapture } from "./captureQueue";
import { NoOwnerError, resolveOwnerId } from "./owner";

export type CaptureFile = { uri: string; name: string; type: string };

// Media is copied BEFORE the row is appended. The other order can leave a row
// pointing at a file that was never written if the copy fails — a permanently
// unresolvable capture the user believes is saved. This order can only leak a
// file with no row, which sweepOrphans reclaims.
export async function enqueueCapture(
  file: CaptureFile,
  kind: "photo" | "voice",
  mealSlot?: string,
): Promise<QueuedCapture> {
  const ownerId = await resolveOwnerId();
  if (!ownerId) throw new NoOwnerError();

  const id = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const storedName = await copyIntoQueue(file.uri, id, file.name);

  try {
    return await append({
      id, kind, storedName, fileName: file.name, mimeType: file.type,
      // The user is holding the phone now: capture time IS now (decision 2).
      capturedAt: new Date().toISOString(),
      ownerId, mealSlot,
    });
  } catch (err) {
    // The row was REFUSED (CaptureQueueFullError at MAX_CAPTURES, or any other
    // storage failure) after the copy above already wrote 1-3 MB to
    // documentDirectory. Without this, every attempt against a full queue
    // leaked another photo that nothing referenced, and only the NEXT launch's
    // sweepOrphans reclaimed it — so a user repeatedly retrying at the cap
    // could add tens of MB in a single session.
    //
    // Cleaning up here rather than checking the cap before copying keeps the
    // check where it is authoritative: `append` decides under the queue lock,
    // so a pre-flight count could pass and the append still refuse. This
    // ordering also preserves the copy-before-append invariant the top of this
    // file exists to state — the only thing a failure can leave behind is a
    // file with no row, and now not even that. deleteQueuedMedia never throws,
    // so the caller still sees the original refusal.
    await deleteQueuedMedia(storedName);
    throw err;
  }
}

// The text sibling of enqueueCapture (kora#196). Deliberately does NOT share a
// body with it: the copy-before-append invariant the header comment above
// exists to state has nothing to protect when there is no file, and there is
// no cleanup path because a refused append can leak nothing.
export async function enqueueTextCapture(
  phrase: string,
  mealSlot?: string,
): Promise<TextCapture> {
  const ownerId = await resolveOwnerId();
  if (!ownerId) throw new NoOwnerError();

  return (await append({
    id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "text",
    phrase,
    // The user is holding the phone now: capture time IS now (decision 2).
    capturedAt: new Date().toISOString(),
    ownerId,
    mealSlot,
  })) as TextCapture;
}

// The barcode sibling (kora#241), for the one case the offline cache cannot
// answer: the FIRST scan of a given product while offline. A seen barcode is
// already served locally by cachedResolution.ts and never reaches here.
//
// Shares enqueueTextCapture's shape rather than enqueueCapture's for the same
// reason: no file, so no copy-before-append invariant and nothing a refused
// append could leak. append() dedupes on `code`, so a scanner firing at the
// same product repeatedly gets one row back, not three — it may therefore
// return a row that was queued earlier, which is still "saved" from the
// caller's point of view.
export async function enqueueBarcodeCapture(
  code: string,
  mealSlot?: string,
): Promise<BarcodeCapture> {
  const ownerId = await resolveOwnerId();
  if (!ownerId) throw new NoOwnerError();

  return (await append({
    id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "barcode",
    code,
    // The user is holding the phone now: capture time IS now (decision 2).
    capturedAt: new Date().toISOString(),
    ownerId,
    mealSlot,
  })) as BarcodeCapture;
}
