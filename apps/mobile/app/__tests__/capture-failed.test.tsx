import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { append, list, markFailed, recordAttempt, MAX_RESOLVE_ATTEMPTS } from "@/offline/captureQueue";
import { copyIntoQueue, mediaExists } from "@/offline/captureMedia";
import CaptureReviewScreen from "../capture-review";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "c1" }),
  router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
}));

// capture-review.tsx now pulls in drainCaptures.ts (for the Retry action),
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

// A UTC instant that lands at midday on the given LOCAL calendar day, so the
// fixture means the same day in every timezone the suite might run in. Fixed
// on a date that is not "today" — see task-7-brief's guidance on coincidental
// passes.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

// retry: false so a queryFn that throws surfaces immediately.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

function makeSourceFile(name: string, contents = "meal-bytes"): string {
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true });
  f.write(contents);
  return f.uri;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockPush.mockClear();
  const storedName = await copyIntoQueue(makeSourceFile("c1-src.jpg"), "c1", "m.jpg");
  await append({
    id: "c1", kind: "photo", storedName, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markFailed("c1", "I couldn't identify that.");
});

it("keeps the failed capture and its media rather than discarding it", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  expect(await screen.findByText(/couldn't identify/i)).toBeTruthy();
  expect(await list()).toHaveLength(1);
});

it("offers manual logging seeded with the CAPTURE time", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/log it manually/i));
  expect(mockPush).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ loggedAt: atLocalNoon(2026, 8, 6) }) }),
  );
});

it("discarding a failed photo removes both the queue row and its media", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/^discard$/i));

  await waitFor(async () => expect(await list()).toEqual([]));
  expect(mediaExists("c1.jpg")).toBe(false);
});

// Rescues the case Discard cannot: attempts exhausted against a transient
// server/network error, where the AI never actually returned a verdict.
it("retrying a failed capture resets it to pending rather than discarding it", async () => {
  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/^retry$/i));

  await waitFor(async () => {
    const [item] = await list();
    expect(item?.status).toBe("pending");
  });
  const [item] = await list();
  expect(item?.attempts).toBe(0);
  // The media must still be there — retry never discards.
  expect(mediaExists("c1.jpg")).toBe(true);
});

// Delivery failures (attempts exhausted against a transient network/HTTP
// error) store the RAW err.message as lastError — captureQueue.ts's
// recordAttempt, not a human-authored string. The screen must not present
// that raw string as if the AI had rendered a verdict.
it("shows a friendly message for a delivery failure instead of the raw error", async () => {
  await AsyncStorage.clear();
  const storedName = await copyIntoQueue(makeSourceFile("c1-src-2.jpg"), "c1", "m.jpg");
  await append({
    id: "c1", kind: "photo", storedName, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  for (let i = 0; i < MAX_RESOLVE_ATTEMPTS; i++) {
    await recordAttempt("c1", "TypeError: Network request failed at fetch (api.ts:42)", true);
  }

  await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  expect(await screen.findByText(/couldn't reach kora/i)).toBeTruthy();
  expect(screen.queryByText(/typeerror/i)).toBeNull();
});

describe("a failed voice capture", () => {
  beforeEach(async () => {
    // useLocalSearchParams above is fixed to id "c1" for the whole file, so
    // the voice fixture reuses that id — AsyncStorage.clear() means it never
    // collides with the outer describe's photo fixture.
    await AsyncStorage.clear();
    mockPush.mockClear();
    await append({
      id: "c1", kind: "voice", storedName: "c1.m4a", fileName: "clip.m4a", mimeType: "audio/mp4",
      capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
    } as Parameters<typeof append>[0]);
    await markFailed("c1", "I couldn't make that out.");
  });

  it("shows the failure reason and offers manual logging without a photo thumbnail", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    expect(await screen.findByText(/couldn't make that out/i)).toBeTruthy();
    expect(screen.queryByLabelText("Captured photo")).toBeNull();
    fireEvent.press(await screen.findByText(/log it manually/i));
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ loggedAt: atLocalNoon(2026, 8, 6) }) }),
    );
  });
});
