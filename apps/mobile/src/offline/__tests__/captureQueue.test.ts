import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  CaptureQueueFullError, MAX_CAPTURES, append, discard, list, markFailed,
  markReview, recordAttempt, retry,
} from "../captureQueue";
import type { Resolution } from "@/api/types";

const RESOLUTION = { tier: "confirm", candidates: [] } as unknown as Resolution;

const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

function input(id: string, over: Partial<Parameters<typeof append>[0]> = {}) {
  return {
    id, kind: "photo" as const, storedName: `${id}.jpg`, fileName: "meal.jpg",
    mimeType: "image/jpeg", capturedAt: atLocalNoon(2026, 8, 6),
    ownerId: "uid-1", ...over,
  };
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
