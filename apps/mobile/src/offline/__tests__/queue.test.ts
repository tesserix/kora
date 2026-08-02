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
  await append(payload, "id-1");
  // A fresh read with no in-memory state is exactly what a cold start does.
  const items = await list();
  expect(items.map((i) => i.id)).toEqual(["id-1"]);
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
