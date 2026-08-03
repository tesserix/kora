import AsyncStorage from "@react-native-async-storage/async-storage";
import { append, list, retry, discard, drain, type QueuedLog } from "../queue";

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

beforeEach(async () => { await AsyncStorage.clear(); });

test("append persists an item as pending and list reads it back", async () => {
  await append(payload, "id-1");
  const items = await list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "id-1", status: "pending", attempts: 0 });
});

test("the queue survives a restart", async () => {
  // This test specifically verifies durable storage, not just in-memory state.
  // If the queue used a plain array instead of AsyncStorage, this test would
  // fail at the getItem assertion or the re-imported module would see an empty
  // queue — while the append test above would still pass unchanged.
  await append(payload, "id-1");

  // Assert the data really is in AsyncStorage, not just in memory.
  const raw = await AsyncStorage.getItem("kora.logQueue");
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw!);
  expect(stored).toHaveLength(1);
  expect(stored[0].id).toBe("id-1");

  // Simulate a cold start by clearing the queue module from require cache.
  // This forces a fresh module load, proving that data survives the restart
  // (not held in module-level state). AsyncStorage is NOT cleared, simulating
  // how persistent storage survives a real app restart.
  delete require.cache[require.resolve("../queue")];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fresh = require("../queue");
  const itemsAfterRestart = await fresh.list();
  expect(itemsAfterRestart.map((i: QueuedLog) => i.id)).toEqual(["id-1"]);
});

test("drain sends items oldest-first and removes those that succeed", async () => {
  await append(payload, "id-1");
  await append(payload, "id-2");
  const sent: string[] = [];
  const result = await drain(async (item) => { sent.push(item.id); });
  expect(sent).toEqual(["id-1", "id-2"]);
  expect(result.sent).toBe(2);
  expect(await list()).toHaveLength(0);
});

test("a permanent failure marks the item failed and stops auto-retrying", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("bad request"), { name: "ApiError", status: 400 });
  const first = await drain(async () => { throw err; });
  expect(first.failed).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("failed");
  expect(items[0].lastError).toContain("bad request");

  // A failed item must not be picked up again by a later drain.
  let called = false;
  await drain(async () => { called = true; });
  expect(called).toBe(false);
});

test("a transient failure leaves the item pending for the next drain", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("offline"), { name: "NetworkError" });
  const result = await drain(async () => { throw err; });
  expect(result.deferred).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("pending");
  expect(items[0].attempts).toBe(1);
});

// AuthTokenError must be treated as transient, not permanent. Per PR #77 it
// wraps getIdToken() rejecting, whose usual cause is a dropped connection
// rather than an unusable session — marking it failed would strand a
// perfectly good log behind a manual retry the user never asked for.
test("an auth-token failure is transient, not permanent", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("token unavailable"), { name: "AuthTokenError" });
  const result = await drain(async () => { throw err; });

  expect(result.deferred).toBe(1);
  expect(result.failed).toBe(0);
  expect((await list())[0].status).toBe("pending");
});

// A 401 must not be lumped in with the other 4xx. It means "not authenticated
// YET" — usually a drain that raced Firebase restoring the session on cold
// start — and it self-heals as soon as a token exists, unlike a 400 or a 422
// which will fail identically forever. Marking it failed strands a perfectly
// good log behind a manual retry that has no UI.
test("a 401 is transient, not permanent", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("unauthenticated"), { name: "ApiError", status: 401 });
  const result = await drain(async () => { throw err; });

  expect(result.deferred).toBe(1);
  expect(result.failed).toBe(0);
  expect((await list())[0].status).toBe("pending");
});

// A 403 is the opposite animal: authenticated, but not allowed. api.ts only
// force-refreshes the token on a 401, so nothing about a 403 changes by itself,
// and drain has no attempt ceiling — leaving it pending would replay it on every
// cold start, reconnect and foreground, forever, with no failed state for a
// retry UI to surface.
test("a 403 is permanent — authenticated but not allowed will not self-heal", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("forbidden"), { name: "ApiError", status: 403 });
  const result = await drain(async () => { throw err; });

  expect(result.failed).toBe(1);
  expect(result.deferred).toBe(0);
  expect((await list())[0].status).toBe("failed");
});

test("retry flips a failed item back to pending; discard removes it", async () => {
  await append(payload, "id-1");
  await append(payload, "id-2");
  const err = Object.assign(new Error("bad"), { name: "ApiError", status: 400 });
  await drain(async () => { throw err; });

  await retry("id-1");
  expect((await list()).find((i) => i.id === "id-1")!.status).toBe("pending");

  await discard("id-2");
  expect((await list()).map((i) => i.id)).toEqual(["id-1"]);
});

test("a corrupt stored value yields an empty queue instead of throwing", async () => {
  await AsyncStorage.setItem("kora.logQueue", "{not json");
  await expect(list()).resolves.toEqual([]);
});
