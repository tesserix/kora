import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { apiFetch, currentUserId } from "@/lib/api";
import type { FoodItem } from "@/api/types";
import { append, drain, list } from "../queue";
import { upsertFoods } from "../foodCache";
import { drainLogs } from "../drainLogs";
import { useQueuedLogs } from "../useQueuedLogs";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
}));

// 62 kcal/100 g logged at 150 g is 93 kcal — a number that shares no digits
// with either input, so a hook that echoed `quantity_grams` (150), returned
// the per-100g figure (62), or scaled the wrong way (62 * 100 / 150 = 41.3)
// all produce a visibly different answer.
const yogurt = {
  id: "f1",
  name: "Greek yogurt",
  brand: "",
  provenance: "usda",
  serving_desc: "100 g",
  serving_grams: 100,
  kcal_per_100g: 62,
  protein_per_100g: 10,
  carbs_per_100g: 4,
  fat_per_100g: 0.4,
} as FoodItem;

// A UTC instant that lands at midday on the given LOCAL calendar day. Written
// this way rather than as a "...T12:00:00Z" literal so the fixtures mean the
// same day in every timezone the suite might run in.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

const payloadOn = (iso: string, foodItemId = "f1") => ({
  food_item_id: foodItemId,
  meal_slot: "lunch",
  source: "manual",
  quantity_grams: 150,
  logged_at: iso,
});

// retry: false so a queryFn that throws surfaces immediately rather than
// stalling the test behind react-query's backoff.
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

// renderHook is async under React 19's concurrent root (see any `await
// render(...)` in this repo's component tests).
const renderQueued = (date: string, client: QueryClient = newClient()) =>
  renderHook(() => useQueuedLogs(date), { wrapper: wrap(client) });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  (currentUserId as jest.Mock).mockReturnValue("user-a");
  await upsertFoods([yogurt]);
});

test("returns queued rows for the requested day, with kcal from the cached food", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "q1", "user-a");

  const { result } = await renderQueued("2026-08-02");

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({
    id: "q1",
    description: "Greek yogurt",
    status: "pending",
    mealSlot: "lunch",
  });
  // 150 g of a 62 kcal/100 g food.
  expect(result.current.rows[0].kcal).toBe(93);
});

// Paired with a same-day item on purpose: asserting only that the other day is
// absent would pass just as well against a hook that always returns nothing.
test("excludes queued rows belonging to another day while keeping that day's own", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 1)), "yesterday", "user-a");
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "today", "user-a");

  const { result } = await renderQueued("2026-08-02");

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows.map((r) => r.id)).toEqual(["today"]);
});

// The diary's `date` is the DEVICE's calendar day (diary.tsx's `iso()`), and
// the server files a log under the user's own timezone too (see
// LocFromContext in api/internal/user/middleware.go). `logged_at`, though, is
// a bare UTC instant — `new Date().toISOString()` at capture. Comparing its
// UTC date prefix therefore files an early-morning log east of UTC, or a
// late-evening one west of it, under the wrong day, where it sits until a
// drain silently moves it.
//
// Both fixtures are built from LOCAL components. In a UTC run their UTC
// prefixes would equal their local dates and this test would silently become a
// duplicate of the plain day filter above — passing against either
// implementation. jest.globalSetup.js pins the suite to Asia/Kolkata (+05:30)
// so that cannot happen, and the guard below fails loudly if the pin ever
// stops taking effect.
test("files a queued row under the device's calendar day, not its UTC one", async () => {
  const justAfterMidnight = new Date(2026, 7, 2, 0, 30).toISOString();
  const justBeforeMidnight = new Date(2026, 7, 2, 23, 30).toISOString();
  // The whole point of the fixture: local 2nd, UTC 1st.
  expect(justAfterMidnight.slice(0, 10)).not.toBe("2026-08-02");

  await append(payloadOn(justAfterMidnight), "just-after-midnight", "user-a");
  await append(payloadOn(justBeforeMidnight), "just-before-midnight", "user-a");

  const { result } = await renderQueued("2026-08-02");

  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  expect(result.current.rows.map((r) => r.id)).toEqual(["just-after-midnight", "just-before-midnight"]);
});

// The queue's storage key is device-wide but accounts are not, so `list()`
// returns every user's items. drain already refuses to send another user's log
// (queue.ts); the diary must refuse to SHOW it, or user B sees user A's meal —
// and its calories — in their day. Paired with an own item for the same reason
// as the day test above.
test("excludes queued rows belonging to another user while keeping this user's own", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "mine", "user-a");
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "theirs", "user-b");

  const { result } = await renderQueued("2026-08-02");

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows.map((r) => r.id)).toEqual(["mine"]);
});

// The owner filter keeps another user's rows out of the STORAGE read, but
// react-query hands a query whose key it has seen before that key's cached
// data synchronously, before any refetch runs. So with the owner absent from
// the key, the first frame after an account switch paints user A's queued
// meals into user B's diary — the same leak, arriving through the cache
// instead. Nothing in the app calls queryClient.clear() on sign-out, so the
// key is the only structural defence.
//
// Asserting on the settled state alone would not catch this: the refetch
// resolves to B's rows either way. Every frame from the switch onward has to
// be clean, so the render callback records them all.
test("an account switch never renders the previous user's queued rows", async () => {
  const client = newClient();
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "a-row", "user-a");
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "b-row", "user-b");

  const seen: string[][] = [];
  const { result, rerender } = await renderHook(
    () => {
      const q = useQueuedLogs("2026-08-02");
      seen.push(q.rows.map((r) => r.id));
      return q;
    },
    { wrapper: wrap(client) },
  );
  await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["a-row"]));

  const switchedAt = seen.length;
  (currentUserId as jest.Mock).mockReturnValue("user-b");
  await rerender(undefined);

  await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["b-row"]));
  expect(seen.slice(switchedAt).flat()).not.toContain("a-row");
});

// The food cache is a 300-entry LRU, so a food can be evicted between queueing
// a log and looking at the diary. There is no honest kcal to show then — `0`
// would be a wrong number the day total would silently believe.
test("reports an unknown kcal rather than zero when the food is no longer cached", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 2), "evicted"), "q1", "user-a");

  const { result } = await renderQueued("2026-08-02");

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ description: "Queued item", kcal: null });
});

test("discardRow removes the row", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "q1", "user-a");
  const { result } = await renderQueued("2026-08-02");
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  await act(async () => {
    await result.current.discardRow("q1");
  });

  await waitFor(() => expect(result.current.rows).toHaveLength(0));
  expect(await list()).toHaveLength(0);
});

test("retryRow returns a failed row to pending", async () => {
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "q1", "user-a");
  // The real way an item becomes "failed": a drain that hits a permanent 4xx.
  await drain(async () => {
    throw Object.assign(new Error("bad request"), { status: 400 });
  }, "user-a");

  const { result } = await renderQueued("2026-08-02");
  await waitFor(() => expect(result.current.rows[0]?.status).toBe("failed"));

  await act(async () => {
    await result.current.retryRow("q1");
  });

  await waitFor(() => expect(result.current.rows[0]?.status).toBe("pending"));
});

// Addition B. drainLogs invalidates ["logs"]/["dashboard"] when it sends, so
// the real server row arrives on its own. If the queued copy is not also
// refreshed, both are on screen at once and the meal is counted twice.
test("a queued row disappears from the hook once a real drain sends it", async () => {
  const client = newClient();
  (apiFetch as jest.Mock).mockResolvedValue({ id: "q1" });
  await append(payloadOn(atLocalNoon(2026, 8, 2)), "q1", "user-a");

  const { result } = await renderQueued("2026-08-02", client);
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  await act(async () => {
    await drainLogs(client);
  });

  // The drain really did send and clear the item, so an empty `rows` below can
  // only mean the hook noticed — not that the drain quietly did nothing.
  expect(await list()).toHaveLength(0);
  await waitFor(() => expect(result.current.rows).toEqual([]));
});
