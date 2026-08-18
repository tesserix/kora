import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  append, CaptureQueueFullError, discard, hasMedia, list, markFailed, markReview,
  MAX_CAPTURES, MAX_TEXT_CAPTURES, recordAttempt, restore, retry,
} from "../captureQueue";
import type { Resolution } from "@/api/types";

const RESOLUTION = { tier: "confirm", candidates: [] } as unknown as Resolution;

const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

// Explicit return type + cast: without it, TS distributes the merge of
// `over: Partial<AppendCaptureInput>` (a discriminated union) across a plain
// object spread into an unhelpful union-of-partial-merges instead of the
// single AppendCaptureInput shape every caller here actually wants.
function input(
  id: string,
  over: Partial<Parameters<typeof append>[0]> = {},
): Parameters<typeof append>[0] {
  return {
    id, kind: "photo" as const, storedName: `${id}.jpg`, fileName: "meal.jpg",
    mimeType: "image/jpeg", capturedAt: atLocalNoon(2026, 8, 6),
    ownerId: "uid-1", ...over,
  } as Parameters<typeof append>[0];
}

beforeEach(async () => { await AsyncStorage.clear(); });

describe("captureQueue", () => {
  it("appends and reads back a pending capture", async () => {
    await append(input("c1"));
    const [item] = await list();
    expect(item).toMatchObject({ id: "c1", status: "pending", attempts: 0, ownerId: "uid-1" });
  });

  // One bad record must never wedge the whole queue — mirrors queue.ts's list().
  it("drops malformed entries instead of throwing", async () => {
    await AsyncStorage.setItem("kora.captureQueue", JSON.stringify([{ nope: true }, null, 7]));
    await expect(list()).resolves.toEqual([]);
  });

  it("returns an empty queue for corrupt JSON", async () => {
    await AsyncStorage.setItem("kora.captureQueue", "{not json");
    await expect(list()).resolves.toEqual([]);
  });

  // Concurrent read-modify-writes over one JSON blob drop each other's changes
  // without the lock — for this queue that is a meal the user was told was saved.
  it("serialises concurrent appends so none is lost", async () => {
    await Promise.all([append(input("a")), append(input("b")), append(input("c"))]);
    expect((await list()).map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  // Refuse rather than evict: silently dropping the oldest discards a meal the
  // user believes is saved, which is the exact failure this feature prevents.
  it("refuses a capture past the cap instead of evicting the oldest", async () => {
    for (let i = 0; i < MAX_CAPTURES; i++) await append(input(`c${i}`));
    await expect(append(input("overflow"))).rejects.toBeInstanceOf(CaptureQueueFullError);
    const items = await list();
    expect(items).toHaveLength(MAX_CAPTURES);
    expect(items.map((i) => i.id)).toContain("c0");
  });

  it("markReview stores the resolution and flips status", async () => {
    await append(input("c1"));
    await markReview("c1", RESOLUTION);
    const [item] = await list();
    expect(item.status).toBe("review");
    expect(item.resolution).toEqual(RESOLUTION);
  });

  it("markFailed records a reason and the caller's failureKind", async () => {
    await append(input("c1"));
    await markFailed("c1", "I couldn't identify that", "identification");
    const [item] = await list();
    expect(item).toMatchObject({
      status: "failed", lastError: "I couldn't identify that", failureKind: "identification",
    });
  });

  // attempts hitting the cap is ITSELF a delivery failure (the AI never
  // returned a verdict — the request just never got through), so recordAttempt
  // must tag it "delivery" the same way a permanent 4xx does, without a caller
  // having to pass it in explicitly.
  it("recordAttempt tags the row 'delivery' the moment attempts exhaust", async () => {
    await append(input("c1"));
    for (let i = 0; i < 4; i++) await recordAttempt("c1", "server said 500", true);
    expect((await list())[0]).toMatchObject({ status: "pending" });
    expect((await list())[0].failureKind).toBeUndefined();
    await recordAttempt("c1", "server said 500", true);
    expect((await list())[0]).toMatchObject({ status: "failed", failureKind: "delivery" });
  });

  // A row written before this field existed has no failureKind at all — it
  // must still be accepted by isValid (list()'s filter), not silently dropped
  // from the queue.
  it("list accepts a legacy row with no failureKind", async () => {
    const legacy = { ...input("c1"), status: "failed", attempts: 1, lastError: "boom", queuedAt: atLocalNoon(2026, 8, 6) };
    await AsyncStorage.setItem("kora.captureQueue", JSON.stringify([legacy]));
    const [item] = await list();
    expect(item).toMatchObject({ id: "c1", status: "failed" });
    expect(item.failureKind).toBeUndefined();
  });

  // counts=false is the offline case: the request never got a verdict, so the
  // item is WAITING, not being refused, and must not age toward the ceiling.
  it("recordAttempt only increments when the failure carried a verdict", async () => {
    await append(input("c1"));
    await recordAttempt("c1", "network down", false);
    expect((await list())[0]).toMatchObject({ attempts: 0, status: "pending" });
    await recordAttempt("c1", "server said 500", true);
    expect((await list())[0]).toMatchObject({ attempts: 1, status: "pending" });
  });

  it("retry resets attempts and clears the error and failureKind", async () => {
    await append(input("c1"));
    await markFailed("c1", "boom", "identification");
    await recordAttempt("c1", "boom", true);
    await retry("c1");
    const item = (await list())[0];
    expect(item).toMatchObject({ status: "pending", attempts: 0 });
    expect(item.lastError).toBeUndefined();
    expect(item.failureKind).toBeUndefined();
  });

  it("discard removes the row", async () => {
    await append(input("c1"));
    await discard("c1");
    await expect(list()).resolves.toEqual([]);
  });
});

// kora#196. The queue was media-shaped: `kind` was "photo" | "voice" and
// isValid rejected anything else, so a typed capture had nowhere to live.
describe("text captures (kora#196)", () => {
  const textInput = {
    id: "cap_text_1",
    kind: "text" as const,
    phrase: "chicken and rice",
    capturedAt: "2026-08-18T10:00:00.000Z",
    ownerId: "owner-1",
  };

  it("accepts a text row and reads it back with its phrase", async () => {
    await append(textInput);
    const [row] = await list();
    expect(row!.kind).toBe("text");
    expect(row).toMatchObject({ phrase: "chicken and rice", status: "pending", attempts: 0 });
  });

  // The upgrade guard, and the most important test in this change. isValid
  // silently DROPS rows it rejects, so a shipped-build media row that stops
  // validating deletes a user's queued photos on update. It cannot be caught
  // on a simulator either — no media capture can be staged there.
  it("still accepts a row written by the shipped, media-only build", async () => {
    await AsyncStorage.setItem(
      "kora.captureQueue",
      JSON.stringify([{
        id: "cap_old_1", kind: "photo", storedName: "cap_old_1.jpg",
        fileName: "meal.jpg", mimeType: "image/jpeg",
        capturedAt: "2026-08-17T10:00:00.000Z", queuedAt: "2026-08-17T10:00:00.000Z",
        status: "pending", attempts: 0, ownerId: "owner-1",
      }]),
    );
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("photo");
  });

  it("drops a text row with no phrase rather than queueing an empty capture", async () => {
    await AsyncStorage.setItem(
      "kora.captureQueue",
      JSON.stringify([{
        id: "cap_bad", kind: "text", phrase: "",
        capturedAt: "2026-08-18T10:00:00.000Z", queuedAt: "2026-08-18T10:00:00.000Z",
        status: "pending", attempts: 0, ownerId: "owner-1",
      }]),
    );
    expect(await list()).toEqual([]);
  });

  // MAX_CAPTURES exists for BYTES ("a photo at quality 0.7 is roughly 1-3 MB").
  // A few hundred bytes of text must not be refused because 20 photos are
  // queued — typed is the mode with no safety net today.
  it("does not let a full media queue refuse a text capture", async () => {
    for (let i = 0; i < MAX_CAPTURES; i++) {
      await append({
        id: `cap_${i}`, kind: "photo", storedName: `cap_${i}.jpg`,
        fileName: "m.jpg", mimeType: "image/jpeg",
        capturedAt: "2026-08-18T10:00:00.000Z", ownerId: "owner-1",
      });
    }
    await expect(append(textInput)).resolves.toMatchObject({ kind: "text" });
  });

  it("refuses a text capture past its own ceiling", async () => {
    for (let i = 0; i < MAX_TEXT_CAPTURES; i++) {
      await append({ ...textInput, id: `cap_t_${i}` });
    }
    await expect(append({ ...textInput, id: "cap_t_over" })).rejects.toThrow(CaptureQueueFullError);
  });

  it("does not let a full text queue refuse a photo", async () => {
    for (let i = 0; i < MAX_TEXT_CAPTURES; i++) {
      await append({ ...textInput, id: `cap_t_${i}` });
    }
    await expect(append({
      id: "cap_photo", kind: "photo", storedName: "cap_photo.jpg",
      fileName: "m.jpg", mimeType: "image/jpeg",
      capturedAt: "2026-08-18T10:00:00.000Z", ownerId: "owner-1",
    })).resolves.toMatchObject({ kind: "photo" });
  });

  it("hasMedia narrows a media row and rejects a text row", async () => {
    await append(textInput);
    const [row] = await list();
    expect(hasMedia(row!)).toBe(false);
  });
});
