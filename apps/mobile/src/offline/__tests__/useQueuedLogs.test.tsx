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
// Both fixtures are built from LOCAL components, so on any device not running
// in UTC at least one of them has a UTC date that differs from its local one.
// On a UTC machine the two notions coincide and this degrades to the plain
// day filter above.
test("files a queued row under the device's calendar day, not its UTC one", async () => {
  await append(payloadOn(new Date(2026, 7, 2, 0, 30).toISOString()), "just-after-midnight", "user-a");
  await append(payloadOn(new Date(2026, 7, 2, 23, 30).toISOString()), "just-before-midnight", "user-a");

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
