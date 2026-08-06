import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import { append, markReview } from "../captureQueue";
import { useQueuedCaptures } from "../useQueuedCaptures";
import type { Resolution } from "@/api/types";

// Full mock, not a spread over jest.requireActual: @/lib/api imports
// firebase/auth, which ships ESM that jest cannot parse without a real
// transform. useQueuedCaptures pulls in drainCaptures (for retryRow), which
// reaches apiFetchMultipart, so that has to be mocked too even though these
// tests never call it.
jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "uid-1"),
  isNetworkError: () => false,
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

const RESOLUTION = { tier: "confirm", candidates: [] } as unknown as Resolution;

// A UTC instant that lands at midday on the given LOCAL calendar day. Written
// this way rather than as a "...T12:00:00Z" literal so the fixtures mean the
// same day in every timezone the suite might run in.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

// retry: false so a queryFn that throws surfaces immediately rather than
// stalling the test behind react-query's backoff.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

async function seed(id: string, capturedAt: string, ownerId = "uid-1") {
  await append({
    id, kind: "photo", storedName: `${id}.jpg`, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt, ownerId,
  } as Parameters<typeof append>[0]);
}

beforeEach(async () => { await AsyncStorage.clear(); });

// The fixture day is deliberately NOT today (see the current system date at
// the top of this suite's run): `queuedAt` is stamped at append() time, i.e.
// "now", so an implementation that read `queuedAt` instead of `capturedAt`
// would look at today's date and find nothing here. Picking a fixture day
// that happens to equal today would let that bug hide behind the coincidence
// — as it did before this fix.
it("shows a capture on the day it was CAPTURED", async () => {
  await seed("c1", atLocalNoon(2026, 8, 1));
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-01"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ id: "c1", status: "pending", kcal: null });
});

// These rows are read from AsyncStorage, not the network, and exist
// precisely WHEN OFFLINE. Under react-query's default networkMode ("online")
// a query with no cached data is PAUSED rather than run while the
// onlineManager reports offline — the one condition this hook exists to
// serve. None of this suite's other tests put the client offline, so none of
// them can catch a regression here; slice 1 of this feature shipped fourteen
// offline tests that all ran online, and the underlying bug went unnoticed
// until this test was added.
it("resolves rows even while the device is offline", async () => {
  onlineManager.setOnline(false);
  try {
    await seed("c1", atLocalNoon(2026, 8, 1));
    const { result } = await renderHook(() => useQueuedCaptures("2026-08-01"), { wrapper: wrap(newClient()) });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0]).toMatchObject({ id: "c1" });
  } finally {
    onlineManager.setOnline(true);
  }
});

// A review row has macros but the user has not accepted them. Counting them
// would make the day total MOVE when the user REJECTS a suggestion.
it("reports kcal null for a review row so it cannot enter day totals", async () => {
  await seed("c1", atLocalNoon(2026, 8, 6));
  await markReview("c1", RESOLUTION);
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ status: "review", kcal: null });
});

// Asserting an empty result cannot distinguish "the filter worked" from "the
// query hasn't run yet" — `rows` starts out as the NO_ROWS `[]` constant
// before the first fetch resolves, and `waitFor` succeeds on its very first
// synchronous check if the expected value already matches that initial
// state. Deleting the owner filter entirely would have passed this test
// unchanged. Seeding an own-user row alongside the other user's forces the
// query to genuinely resolve — the initial `[]` state fails `toHaveLength(1)`
// — and asserting on the returned id confirms the RIGHT one survived.
it("never shows another user's capture", async () => {
  await seed("mine", atLocalNoon(2026, 8, 6), "uid-1");
  await seed("theirs", atLocalNoon(2026, 8, 6), "uid-2");
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows.map((r) => r.id)).toEqual(["mine"]);
});

// Same fix as above, for the day filter: deleting `localDay(c.capturedAt) ===
// date` from useQueuedCaptures.ts would have passed the old version of this
// test unchanged, silently shipping a bug where every queued capture on the
// device appears on every day the user views. Seeding a same-day row too
// means only a real, correct filter produces exactly one row.
it("excludes captures from other days", async () => {
  await seed("today", atLocalNoon(2026, 8, 6));
  await seed("yesterday", atLocalNoon(2026, 8, 5));
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows.map((r) => r.id)).toEqual(["today"]);
});
