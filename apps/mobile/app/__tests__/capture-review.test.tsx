import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { router } from "expo-router";
import { append, list as listCaptures, markReview, discard } from "@/offline/captureQueue";
import { copyIntoQueue, mediaExists, deleteQueuedMedia } from "@/offline/captureMedia";
import { append as appendLog, list as listLogs } from "@/offline/queue";
import CaptureReviewScreen from "../capture-review";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import type { QueuedCapture } from "@/offline/captureQueue";

// The real queues/media, with the mutating entry points wrapped so individual
// tests can override one call's outcome (mirrors the identical pattern in
// src/api/__tests__/useInstantLog.test.tsx: `discard: jest.fn(actual.discard)`).
// Every other test in this file relies on the wrapped functions calling
// straight through to the real, AsyncStorage/expo-file-system-backed
// implementation by default.
jest.mock("@/offline/queue", () => {
  const actual = jest.requireActual("@/offline/queue");
  return { ...actual, append: jest.fn(actual.append) };
});
jest.mock("@/offline/captureQueue", () => {
  const actual = jest.requireActual("@/offline/captureQueue");
  return { ...actual, list: jest.fn(actual.list), discard: jest.fn(actual.discard) };
});
jest.mock("@/offline/captureMedia", () => {
  const actual = jest.requireActual("@/offline/captureMedia");
  return { ...actual, deleteQueuedMedia: jest.fn(actual.deleteQueuedMedia) };
});

// A realistic capture-queue key (src/offline/enqueueCapture.ts mints exactly
// this shape), so the id the log queue is handed cannot accidentally look like
// a UUID just because the fixture was short.
const CAPTURE_ID = "cap_1754476800000_a1b2c3";

jest.mock("expo-router", () => ({
  // The literal, not the CAPTURE_ID const above: a jest.mock factory is
  // hoisted above const initialisation and may execute before it (the same
  // hazard capture-offline-queue.test.tsx documents). beforeEach asserts the
  // two still agree.
  useLocalSearchParams: () => ({ id: "cap_1754476800000_a1b2c3" }),
  router: { back: jest.fn(), push: jest.fn() },
}));

// capture-review.tsx now pulls in drainCaptures.ts (task 8's Retry action),
// which imports @/lib/api — and that transitively pulls in firebase/auth's
// ESM build, which crashes the Jest transform unmocked. Mirrors the mock
// shape src/offline/__tests__/useQueuedLogs.test.tsx uses for the same reason.
jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "uid-1"),
  isNetworkError: () => false,
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

const RESOLUTION = {
  tier: "confirm",
  candidates: [{ item: { id: "food-1", name: "Oats", kcal_per_100g: 389 }, portion_grams: 100 }],
} as unknown as Resolution;

// A UTC instant that lands at midday on the given LOCAL calendar day, so the
// fixture means the same day in every timezone the suite might run in. Fixed
// on a date that is not "today" — see task-7-brief's guidance on coincidental
// passes.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

// Plain fixture helpers, local to this file (task-1-brief: "do not import
// fixtures from source files"). Return exactly the shapes declared in
// src/api/types.ts and src/offline/captureQueue.ts.
function candidateFixture(overrides: {
  id?: string;
  name?: string;
  portion_grams?: number;
  tier?: ResolvedCandidate["tier"];
} = {}): ResolvedCandidate {
  const { id = "food-1", name = "Oats", portion_grams = 100, tier } = overrides;
  return {
    item: {
      id,
      name,
      brand: "",
      provenance: "",
      serving_desc: "",
      serving_grams: portion_grams,
      kcal_per_100g: 200,
      protein_per_100g: 10,
      carbs_per_100g: 20,
      fat_per_100g: 5,
    },
    portion_grams,
    kcal: Math.round((200 * portion_grams) / 100),
    match_score: 0.9,
    match_tier: "high",
    ...(tier ? { tier } : {}),
  };
}

function resolutionFixture(overrides: Partial<Resolution> = {}): Resolution {
  return {
    tier: "confirm",
    candidates: [candidateFixture()],
    is_estimate: false,
    provenance: "ai_photo",
    ...overrides,
  };
}

function queuedCaptureFixture(overrides: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    id: CAPTURE_ID,
    kind: "photo",
    storedName: "c1.jpg",
    fileName: "m.jpg",
    mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6),
    status: "review",
    attempts: 0,
    ownerId: "uid-1",
    queuedAt: atLocalNoon(2026, 8, 6),
    ...overrides,
  };
}

// Makes the screen's own `listCaptures()` call resolve with exactly this
// array, bypassing AsyncStorage entirely — `list` is wrapped (see the
// jest.mock above) precisely so this one call can be swapped out without
// disturbing every other test's real, storage-backed setup.
function mockListCaptures(captures: QueuedCapture[]): void {
  (listCaptures as jest.Mock).mockResolvedValueOnce(captures);
}

// See the identical constant in src/offline/__tests__/drainCaptures.test.ts:
// the log-queue id travels to the server as `ID *uuid.UUID`, so the capture's
// own `cap_<millis>_<rand>` key cannot stand in for it.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// retry: false so a queryFn that throws surfaces immediately.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

beforeEach(async () => {
  // The route param is a literal inside the hoisted mock factory; if these
  // ever drift the screen would render "not found" and every assertion below
  // would fail confusingly instead of here.
  expect(CAPTURE_ID).toBe("cap_1754476800000_a1b2c3");
  // Clears call history (never implementation — see the jest.mock blocks
  // above) so one test's appendLog/discard/deleteQueuedMedia/listCaptures
  // call counts never leak into the next.
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await append({
    id: CAPTURE_ID, kind: "photo", storedName: "c1.jpg", fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markReview(CAPTURE_ID, RESOLUTION);
});

it("confirming hands the capture to the log queue at its capture time", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText("Confirm"));

  await waitFor(async () => expect(await listLogs()).toHaveLength(1));
  const [log] = await listLogs();
  expect(log.payload.logged_at).toBe(atLocalNoon(2026, 8, 6));
  await expect(listCaptures()).resolves.toEqual([]);
});

it("rejecting discards the capture without logging anything", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/not right|reject|discard/i));

  await waitFor(async () => expect(await listCaptures()).toEqual([]));
  await expect(listLogs()).resolves.toEqual([]);
});

// The id drainLogs will send as the request body's `id`. The server binds it
// as `ID *uuid.UUID` (api/internal/foodlog/service.go), so handing over the
// capture's own key 400s — and the log queue calls a 400 permanent, after
// handleConfirm has already deleted the media.
it("confirming mints a fresh v4 UUID for the log, never reusing the capture id", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText("Confirm"));

  await waitFor(async () => expect(await listLogs()).toHaveLength(1));
  const [log] = await listLogs();
  expect(log.id).toMatch(UUID_V4);
  expect(log.id).not.toBe(CAPTURE_ID);
});

// A confirmed row's food identity, portion, and source must survive intact —
// otherwise the log lands with the right timestamp but the wrong food, which
// the two tests above cannot tell apart from a correct implementation.
it("confirming logs the reviewed candidate's identity and source, not a placeholder", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText("Confirm"));

  await waitFor(async () => expect(await listLogs()).toHaveLength(1));
  const [log] = await listLogs();
  expect(log.payload.food_item_id).toBe("food-1");
  expect(log.payload.quantity_grams).toBe(100);
  expect(log.payload.source).toBe("ai_photo");
});

// A follow_up resolution that actually ASKS something: resolveResultView sends
// it to the question branch, where the only controls are "Search manually" and
// Discard — Confirm is disabled because a question names no food to log.
const FOLLOW_UP = {
  tier: "follow_up",
  follow_up_question: "Was that with or without dressing?",
  candidates: [],
} as unknown as Resolution;

function makeSourceFile(name: string, contents = "meal-bytes"): string {
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true });
  f.write(contents);
  return f.uri;
}

describe("a follow_up capture parked in review", () => {
  let storedName: string;

  beforeEach(async () => {
    await AsyncStorage.clear();
    (router.push as jest.Mock).mockClear();
    storedName = await copyIntoQueue(makeSourceFile("fu-src.jpg"), CAPTURE_ID, "m.jpg");
    await append({
      id: CAPTURE_ID, kind: "photo", storedName, fileName: "m.jpg", mimeType: "image/jpeg",
      capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
    } as Parameters<typeof append>[0]);
    await markReview(CAPTURE_ID, FOLLOW_UP);
  });

  // Decision 2 on the fourth and last log-creating path. Pushing "/log" bare
  // makes log.tsx fall back to `new Date()`, so a capture taken yesterday
  // would be logged against today.
  it("seeds manual logging with the CAPTURE time, not now", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByLabelText("Search manually"));

    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/log",
        params: expect.objectContaining({ loggedAt: atLocalNoon(2026, 8, 6) }),
      }),
    );
  });

  // The row and its media must SURVIVE. Asserting presence, not absence: a
  // test that only checked navigation happened would pass either way.
  //
  // "Search manually" is a plain link with no confirmation step, so resolving
  // the capture here would destroy the photo before /log even mounted — a
  // misdirected tap, a back-out, or the app being killed on that screen would
  // lose the meal with nothing written. handleLogManually (the FAILED path)
  // keeps both for exactly this reason and this handler must agree with it.
  // Discard is the deliberate exit.
  it("keeps the capture and its media so a misdirected tap loses nothing", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByLabelText("Search manually"));

    await waitFor(() => expect(router.push).toHaveBeenCalled());

    const rows = await listCaptures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CAPTURE_ID, status: "review" });
    expect(mediaExists(storedName)).toBe(true);
    // And nothing was auto-logged: the user is doing that themselves on /log.
    await expect(listLogs()).resolves.toEqual([]);
  });
});

// The capture queue is one device-wide list; accounts are not. A deep link
// `/capture-review?id=…` naming another account's row must behave exactly as
// if the row did not exist — no photo, no playback, and no Discard button
// that would delete their media.
//
// Seeding ONLY the other user's row and asserting "not found" would also pass
// against a screen that simply never loaded anything, so the own-user cases
// above (which render Confirm) are what prove the reader works at all; this
// test proves it discriminates.
it("treats another account's capture as not found", async () => {
  await AsyncStorage.clear();
  await append({
    id: CAPTURE_ID, kind: "photo", storedName: "c1.jpg", fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-2",
  } as Parameters<typeof append>[0]);
  await markReview(CAPTURE_ID, RESOLUTION);

  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });

  expect(await screen.findByText(/no longer waiting on review/i)).toBeTruthy();
  expect(screen.queryByText("Confirm")).toBeNull();
  expect(screen.queryByLabelText("Captured photo")).toBeNull();
  // And the row survives untouched — nothing on this screen could have
  // reached it.
  expect(await listCaptures()).toHaveLength(1);
});

// task-1: capture-review.tsx used to read only resolution?.candidates?.[0]
// and log that ONE item, then delete the capture row and its media — every
// other detected item was destroyed with no trace, even though the card
// above reads "Add 2 items to diary". These tests pin the fix.
describe("confirming a capture with multiple detected items", () => {
  test("confirming a two-item capture logs both items", async () => {
    const capture = queuedCaptureFixture({
      resolution: resolutionFixture({
        candidates: [
          candidateFixture({ id: "food-a", name: "Chicken ramen", portion_grams: 350 }),
          candidateFixture({ id: "food-b", name: "Soft boiled egg", portion_grams: 50 }),
        ],
      }),
    });
    mockListCaptures([capture]);

    const { getByLabelText } = await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(getByLabelText("Add to diary"));

    await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
    expect((appendLog as jest.Mock).mock.calls[0][0]).toMatchObject({ food_item_id: "food-a", quantity_grams: 350 });
    expect((appendLog as jest.Mock).mock.calls[1][0]).toMatchObject({ food_item_id: "food-b", quantity_grams: 50 });
  });

  test("each logged item gets its own fresh log id", async () => {
    const capture = queuedCaptureFixture({
      resolution: resolutionFixture({
        candidates: [candidateFixture({ id: "food-a" }), candidateFixture({ id: "food-b" })],
      }),
    });
    mockListCaptures([capture]);

    const { getByLabelText } = await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(getByLabelText("Add to diary"));

    await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
    const idA = (appendLog as jest.Mock).mock.calls[0][1];
    const idB = (appendLog as jest.Mock).mock.calls[1][1];
    expect(idA).not.toEqual(idB);
  });

  // The capture row and its media are the only copy of an unlogged item. They
  // must not be destroyed while any item still failed to queue.
  test("a partial failure keeps the capture and its media", async () => {
    (appendLog as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("queue full"));
    const capture = queuedCaptureFixture({
      resolution: resolutionFixture({
        candidates: [candidateFixture({ id: "food-a" }), candidateFixture({ id: "food-b" })],
      }),
    });
    mockListCaptures([capture]);

    const { getByLabelText } = await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(getByLabelText("Add to diary"));

    await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
    expect(deleteQueuedMedia).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});

// task-1 step 5: this screen passed no onResolveUncertain to ResolutionResult,
// so an uncertain row's "tap to change" was inert here even though it works on
// the live-capture path (capture.tsx). Wiring it wholesale to the manual-
// search flow is out of scope for this task — only that the row is pressable
// and carries its own index to the route capture-review already uses for
// manual correction.
describe("correcting a single uncertain row", () => {
  test("tapping an uncertain row routes to manual search carrying its index", async () => {
    const capture = queuedCaptureFixture({
      resolution: resolutionFixture({
        candidates: [
          candidateFixture({ id: "food-a", name: "Chicken ramen" }),
          candidateFixture({ id: "food-b", name: "Mystery soup", tier: "follow_up" }),
        ],
      }),
    });
    mockListCaptures([capture]);

    const { getByLabelText } = await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(getByLabelText("Change Mystery soup"));

    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: "/log",
          params: expect.objectContaining({ loggedAt: capture.capturedAt, candidateIndex: "1" }),
        }),
      ),
    );
  });
});
