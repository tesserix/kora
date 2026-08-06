import { Directory, File, Paths } from "expo-file-system";

// Queued media lives in documentDirectory, NOT cache. expo-image-picker hands
// back a cache-directory URI and iOS purges that directory under storage
// pressure, so a capture left there can disappear between queueing and
// draining — #22's "no data loss across app restart" would be false in exactly
// the low-storage conditions where it matters.
const DIR_NAME = "captures";

function dir(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

function ensureDir(): Directory {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

// The stored NAME is persisted, never an absolute URI: documentDirectory's
// absolute path is not stable across iOS app updates, so a persisted URI can
// dangle after an upgrade while the file is still there.
function storedNameFor(id: string, fileName: string): string {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  return `${id}${ext}`;
}

export function queuedMediaUri(storedName: string): string {
  return new File(dir(), storedName).uri;
}

export function mediaExists(storedName: string): boolean {
  return new File(dir(), storedName).exists;
}

export async function copyIntoQueue(
  sourceUri: string,
  id: string,
  fileName: string,
): Promise<string> {
  const target = ensureDir();
  const storedName = storedNameFor(id, fileName);
  const destination = new File(target, storedName);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return storedName;
}

// Never throws. A delete failure must not abort a drain that has already
// delivered the log — the file is at worst a leak the orphan sweep reclaims.
export async function deleteQueuedMedia(storedName: string): Promise<void> {
  try {
    const f = new File(dir(), storedName);
    if (f.exists) f.delete();
  } catch {
    // Reclaimed by sweepOrphans on the next launch.
  }
}

// Deletes every file in the capture directory not named in keepNames.
export async function sweepOrphans(keepNames: string[]): Promise<number> {
  const d = dir();
  if (!d.exists) return 0;
  const keep = new Set(keepNames);
  let deleted = 0;
  for (const entry of d.list()) {
    if (entry instanceof Directory) continue;
    if (keep.has(entry.name)) continue;
    try {
      entry.delete();
      deleted++;
    } catch {
      // Skip; the next sweep retries.
    }
  }
  return deleted;
}
