import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

it("shows a capture on the day it was CAPTURED", async () => {
  await seed("c1", atLocalNoon(2026, 8, 6));
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ id: "c1", status: "pending", kcal: null });
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

it("never shows another user's capture", async () => {
  await seed("theirs", atLocalNoon(2026, 8, 6), "uid-2");
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toEqual([]));
});

it("excludes captures from other days", async () => {
  await seed("c1", atLocalNoon(2026, 8, 5));
  const { result } = await renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toEqual([]));
});
