import { Directory, File, Paths } from "expo-file-system";
import {
  copyIntoQueue, deleteQueuedMedia, mediaExists, queuedMediaUri, sweepOrphans,
} from "../captureMedia";

function makeSourceFile(name: string, contents = "meal-bytes"): string {
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true });
  f.write(contents);
  return f.uri;
}

describe("captureMedia", () => {
  afterEach(async () => { await sweepOrphans([]); });

  it("copies a cache-directory file into the document directory", async () => {
    const src = makeSourceFile("src-1.jpg");
    const stored = await copyIntoQueue(src, "cap-1", "meal.jpg");

    expect(mediaExists(stored)).toBe(true);
    // The stored copy must live under documentDirectory, NOT cache — iOS purges
    // cache under storage pressure and the capture would vanish (#22: no data
    // loss across app restart).
    expect(queuedMediaUri(stored)).toContain(Paths.document.uri);
    expect(queuedMediaUri(stored)).not.toContain(Paths.cache.uri);
  });

  it("survives deletion of the original cache file", async () => {
    const src = makeSourceFile("src-2.jpg");
    const stored = await copyIntoQueue(src, "cap-2", "meal.jpg");

    new File(src).delete();

    expect(mediaExists(stored)).toBe(true);
    expect(new File(queuedMediaUri(stored)).textSync()).toBe("meal-bytes");
  });

  it("gives each capture a distinct file even for identical file names", async () => {
    const a = await copyIntoQueue(makeSourceFile("s-a.jpg", "A"), "cap-a", "meal.jpg");
    const b = await copyIntoQueue(makeSourceFile("s-b.jpg", "B"), "cap-b", "meal.jpg");

    expect(a).not.toBe(b);
    expect(new File(queuedMediaUri(a)).textSync()).toBe("A");
    expect(new File(queuedMediaUri(b)).textSync()).toBe("B");
  });

  it("deleteQueuedMedia removes the file and never throws on a missing one", async () => {
    const stored = await copyIntoQueue(makeSourceFile("src-3.jpg"), "cap-3", "meal.jpg");
    await deleteQueuedMedia(stored);
    expect(mediaExists(stored)).toBe(false);
    await expect(deleteQueuedMedia(stored)).resolves.toBeUndefined();
    await expect(deleteQueuedMedia("never-existed.jpg")).resolves.toBeUndefined();
  });

  // Without this, every crash between "file written" and "row appended" leaks
  // megabytes permanently — the app has no other way to reclaim them.
  it("sweepOrphans deletes unreferenced files and keeps referenced ones", async () => {
    const keep = await copyIntoQueue(makeSourceFile("k.jpg"), "cap-keep", "meal.jpg");
    const orphan = await copyIntoQueue(makeSourceFile("o.jpg"), "cap-orphan", "meal.jpg");

    const deleted = await sweepOrphans([keep]);

    expect(deleted).toBe(1);
    expect(mediaExists(keep)).toBe(true);
    expect(mediaExists(orphan)).toBe(false);
  });

  it("sweepOrphans on an absent directory is a no-op, not a crash", async () => {
    const dir = new Directory(Paths.document, "captures");
    if (dir.exists) dir.delete();
    await expect(sweepOrphans([])).resolves.toBe(0);
  });
});
