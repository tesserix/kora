import { copyIntoQueue } from "./captureMedia";
import { append, type QueuedCapture } from "./captureQueue";
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

  return append({
    id, kind, storedName, fileName: file.name, mimeType: file.type,
    // The user is holding the phone now: capture time IS now (decision 2).
    capturedAt: new Date().toISOString(),
    ownerId, mealSlot,
  });
}
