import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { router } from "expo-router";
import { append, list as listCaptures, markReview } from "@/offline/captureQueue";
import { copyIntoQueue, mediaExists } from "@/offline/captureMedia";
import { list as listLogs } from "@/offline/queue";
import CaptureReviewScreen from "../capture-review";
import type { Resolution } from "@/api/types";

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

  // The dead end: Confirm is disabled for a question, so before this change
  // the only exit was Discard — a user who logged the food manually kept a
  // "Tap to confirm" row sitting over the meal they had just written.
  it("resolves the capture rather than leaving a review row over the manual log", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByLabelText("Search manually"));

    await waitFor(async () => expect(await listCaptures()).toEqual([]));
    expect(mediaExists(storedName)).toBe(false);
    // Taking the meal over manually must not ALSO queue an automatic log, or
    // the user would end up with two.
    await expect(listLogs()).resolves.toEqual([]);
  });
});
