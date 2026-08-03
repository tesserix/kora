import AsyncStorage from "@react-native-async-storage/async-storage";
import { append, list, retry, discard, drain, MAX_DELIVERY_ATTEMPTS, type QueuedLog } from "../queue";

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

beforeEach(async () => { await AsyncStorage.clear(); });

test("append persists an item as pending and list reads it back", async () => {
  await append(payload, "id-1", "user-a");
  const items = await list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "id-1", status: "pending", attempts: 0 });
});

test("the queue survives a restart", async () => {
  // This test specifically verifies durable storage, not just in-memory state.
  // If the queue used a plain array instead of AsyncStorage, this test would
  // fail at the getItem assertion or the re-imported module would see an empty
  // queue — while the append test above would still pass unchanged.
  await append(payload, "id-1", "user-a");

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
  await append(payload, "id-1", "user-a");
  await append(payload, "id-2", "user-a");
  const sent: string[] = [];
  const result = await drain(async (item) => { sent.push(item.id); }, "user-a");
  expect(sent).toEqual(["id-1", "id-2"]);
  expect(result.sent).toBe(2);
  expect(await list()).toHaveLength(0);
});

test("a permanent failure marks the item failed and stops auto-retrying", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("bad request"), { name: "ApiError", status: 400 });
  const first = await drain(async () => { throw err; }, "user-a");
  expect(first.failed).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("failed");
  expect(items[0].lastError).toContain("bad request");

  // A failed item must not be picked up again by a later drain.
  let called = false;
  await drain(async () => { called = true; }, "user-a");
  expect(called).toBe(false);
});

test("a transient failure leaves the item pending for the next drain", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("server error"), { name: "ApiError", status: 500 });
  const result = await drain(async () => { throw err; }, "user-a");
  expect(result.deferred).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("pending");
  // A 500 is a REFUSAL — the request reached the server and came back with a
  // verdict — so it spends one of the item's attempts (MAX_DELIVERY_ATTEMPTS).
  // A failure that never reached the server does not; see the ceiling tests.
  expect(items[0].attempts).toBe(1);
  expect(items[0].lastError).toContain("server error");
});

// AuthTokenError must be treated as transient, not permanent. Per PR #77 it
// wraps getIdToken() rejecting, whose usual cause is a dropped connection
// rather than an unusable session — marking it failed would strand a
// perfectly good log behind a manual retry the user never asked for.
test("an auth-token failure is transient, not permanent", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("token unavailable"), { name: "AuthTokenError" });
  const result = await drain(async () => { throw err; }, "user-a");

  expect(result.deferred).toBe(1);
  expect(result.failed).toBe(0);
  expect((await list())[0].status).toBe("pending");
  // And it must not age toward the ceiling either: no token means the request
  // never left, so there is no refusal to count.
  expect((await list())[0].attempts).toBe(0);
});

// A 401 must not be lumped in with the other 4xx. It means "not authenticated
// YET" — usually a drain that raced Firebase restoring the session on cold
// start — and it self-heals as soon as a token exists, unlike a 400 or a 422
// which will fail identically forever. Marking it failed strands a perfectly
// good log behind a manual retry that has no UI.
test("a 401 is transient, not permanent", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("unauthenticated"), { name: "ApiError", status: 401 });
  const result = await drain(async () => { throw err; }, "user-a");

  expect(result.deferred).toBe(1);
  expect(result.failed).toBe(0);
  expect((await list())[0].status).toBe("pending");
  // It DOES count toward the ceiling, though: unlike a dropped connection, a
  // 401 is the server having answered. One is "not authenticated yet"; five in
  // a row, with drainLogs refusing to send while signed out, is not.
  expect((await list())[0].attempts).toBe(1);
});

// A 403 is the opposite animal: authenticated, but not allowed. api.ts only
// force-refreshes the token on a 401, so nothing about a 403 changes by itself
// — leaving it pending would spend the whole attempt budget before the retry
// UI ever saw it, when it can be surfaced on the very first refusal.
test("a 403 is permanent — authenticated but not allowed will not self-heal", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("forbidden"), { name: "ApiError", status: 403 });
  const result = await drain(async () => { throw err; }, "user-a");

  expect(result.failed).toBe(1);
  expect(result.deferred).toBe(0);
  expect((await list())[0].status).toBe("failed");
});

test("retry flips a failed item back to pending; discard removes it", async () => {
  await append(payload, "id-1", "user-a");
  await append(payload, "id-2", "user-a");
  const err = Object.assign(new Error("bad"), { name: "ApiError", status: 400 });
  await drain(async () => { throw err; }, "user-a");

  await retry("id-1");
  expect((await list()).find((i) => i.id === "id-1")!.status).toBe("pending");

  await discard("id-2");
  expect((await list()).map((i) => i.id)).toEqual(["id-1"]);
});

// The queue is one device-wide list but accounts are not. Without ownership a
// sign-in on a shared device replays the previous user's meals into the new
// user's diary — the server accepts them, because the client-minted id is
// unused and CreateIdempotent simply inserts.
test("a log queued by one user is not sent while another is signed in", async () => {
  await append(payload, "id-a", "user-a");
  await append(payload, "id-b", "user-b");

  const sentForB: string[] = [];
  await drain(async (item) => { sentForB.push(item.id); }, "user-b");
  expect(sentForB).toEqual(["id-b"]);
  // A's log is untouched — not sent, not failed, still waiting for A.
  expect((await list()).map((i) => [i.id, i.status])).toEqual([["id-a", "pending"]]);

  const sentForA: string[] = [];
  await drain(async (item) => { sentForA.push(item.id); }, "user-a");
  expect(sentForA).toEqual(["id-a"]);
  expect(await list()).toHaveLength(0);
});

// Items written before ownership existed belong to nobody. Adopting them into
// whoever is signed in now is the exact bug ownership was added to prevent, so
// they are skipped and left for a retry UI to deal with explicitly.
test("an item stored without an owner is never adopted by the current user", async () => {
  const legacy = {
    id: "legacy-1", payload, status: "pending", attempts: 0,
    queuedAt: "2026-08-01T00:00:00.000Z",
  };
  await AsyncStorage.setItem("kora.logQueue", JSON.stringify([legacy]));

  const sent: string[] = [];
  const result = await drain(async (item) => { sent.push(item.id); }, "user-a");

  expect(sent).toEqual([]);
  expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
  expect((await list()).map((i) => i.id)).toEqual(["legacy-1"]);
});

test("a corrupt stored value yields an empty queue instead of throwing", async () => {
  await AsyncStorage.setItem("kora.logQueue", "{not json");
  await expect(list()).resolves.toEqual([]);
});

// AsyncStorage has no transactions, so every queue write is a read-modify-write
// over the whole list. Two of them in flight at once both read the same list and
// the later save silently drops the earlier one's change. Drains fire on
// foreground and reconnect — exactly while the user is logging — so the meal
// that vanishes is the one the "Logged X" toast just promised was saved.
test("an append and a discard issued concurrently do not lose each other's write", async () => {
  await append(payload, "id-1", "user-a");

  // No await between them: both read the stored list before either saves.
  await Promise.all([discard("id-1"), append(payload, "id-2", "user-a")]);

  expect((await list()).map((i) => i.id)).toEqual(["id-2"]);
});

// Without a ceiling an item that never succeeds replays on every cold start,
// reconnect and foreground forever; it is visible only on the calendar day it
// was logged, counts toward that day's total indefinitely, and there is no UI
// that can retry or discard it (diary.tsx gives onPress to `failed` rows only).
// A bounded number of refusals routes it into that existing sheet.
test("an item the server keeps refusing eventually becomes failed", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("server error"), { name: "ApiError", status: 500 });

  for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
    const r = await drain(async () => { throw err; }, "user-a");
    expect(r.deferred).toBe(1);
    expect((await list())[0].status).toBe("pending");
    expect((await list())[0].attempts).toBe(i);
  }

  const last = await drain(async () => { throw err; }, "user-a");
  expect(last.failed).toBe(1);
  expect(last.deferred).toBe(0);
  expect((await list())[0].status).toBe("failed");

  // And it must stop being auto-sent, like any other failed item.
  let called = false;
  await drain(async () => { called = true; }, "user-a");
  expect(called).toBe(false);
});

// The trap the ceiling must not fall into. Offline is the normal state for a
// queued log, drains fire on every foreground, and a request that never reached
// the server was never REFUSED — the item is waiting, not stuck. Ageing it here
// would mark a perfectly good meal "Failed" after five app launches on a plane.
test("a failure that never reached the server does not age the item toward the ceiling", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("offline"), { name: "NetworkError" });

  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 3; i++) {
    const r = await drain(async () => { throw err; }, "user-a");
    expect(r.deferred).toBe(1);
    expect(r.failed).toBe(0);
  }

  const item = (await list())[0];
  expect(item.status).toBe("pending");
  expect(item.attempts).toBe(0);
});

// Retry is the user saying "try this again". Carrying the old count over would
// spend the whole budget on the first press and re-fail the item instantly,
// making the button look broken.
test("retry resets the attempt count so a retried item gets a full budget", async () => {
  await append(payload, "id-1", "user-a");
  const err = Object.assign(new Error("server error"), { name: "ApiError", status: 500 });
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
    await drain(async () => { throw err; }, "user-a");
  }
  expect((await list())[0].status).toBe("failed");

  await retry("id-1");
  expect((await list())[0].attempts).toBe(0);

  const after = await drain(async () => { throw err; }, "user-a");
  expect(after.deferred).toBe(1);
  expect((await list())[0].status).toBe("pending");
});
