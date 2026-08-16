import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { append, list as listCaptures, markReview } from "@/offline/captureQueue";
import { copyIntoQueue, mediaExists } from "@/offline/captureMedia";
import { list as listLogs } from "@/offline/queue";
import { safeBack } from "@/lib/safeBack";
import CaptureReviewScreen from "../capture-review";
import type { Resolution } from "@/api/types";

// #174 items 2 and 3.
//
// Item 2: the destructive button was labelled "Not right" — which reads as
// "this identification is wrong, try again", exactly what a user wanting to
// re-identify would tap — and it deleted the media and dropped the row with no
// confirmation and no undo, destroying the only copy of the photo.
//
// Item 3: every exit on the one screen that documents deep entry
// (/capture-review?id=…) was a bare router.back(), which dispatches GO_BACK
// into an empty stack on a deep-linked mount.

const CAPTURE_ID = "cap_1754476800000_a1b2c3";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "cap_1754476800000_a1b2c3" }),
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => false) },
}));

jest.mock("@/lib/safeBack", () => ({ safeBack: jest.fn() }));

const mockShow = jest.fn();
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));

// capture-review.tsx pulls in drainCaptures.ts, which imports @/lib/api — and
// that transitively pulls in firebase/auth's ESM build, which crashes the Jest
// transform unmocked. Same mock shape capture-review.test.tsx uses.
// FoodPicker (now rendered by this screen for in-place correction, kora#198)
// pulls in useFoodSearch, whose import chain reaches firebase/app — which Jest
// cannot transform. Mocked to an empty result: these suites are about confirm,
// discard and retry, not about search.
jest.mock("@/api/hooks", () => ({
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

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

const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

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

let storedName: string;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  storedName = await copyIntoQueue(makeSourceFile("discard-src.jpg"), CAPTURE_ID, "m.jpg");
  await append({
    id: CAPTURE_ID, kind: "photo", storedName, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markReview(CAPTURE_ID, RESOLUTION);
});

describe("the destructive action on a reviewed capture", () => {
  test("is labelled for its consequence, not as a correction", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    expect(await screen.findByText("Discard capture")).toBeTruthy();
    expect(screen.queryByText("Not right")).toBeNull();
  });

  test("offers a non-destructive manual-search route alongside it", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByText("Search manually"));

    await waitFor(async () => expect(await listCaptures()).toHaveLength(1));
    expect(mediaExists(storedName)).toBe(true);
    await expect(listLogs()).resolves.toEqual([]);
  });

  test("discarding offers an Undo rather than silently destroying the capture", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByText("Discard capture"));

    await waitFor(async () => expect(await listCaptures()).toEqual([]));
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({ actionLabel: "Undo", onAction: expect.any(Function) }),
    );
  });

  // The whole point of the Undo: the media is the user's only copy, so it must
  // still be on disk while the toast is up, and the row must come back whole
  // (status and resolution intact, not re-queued as a fresh pending capture).
  test("Undo restores both the row and its media", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByText("Discard capture"));

    await waitFor(async () => expect(await listCaptures()).toEqual([]));
    expect(mediaExists(storedName)).toBe(true);

    await mockShow.mock.calls[0][0].onAction();

    await waitFor(async () => expect(await listCaptures()).toHaveLength(1));
    const [restored] = await listCaptures();
    expect(restored).toMatchObject({ id: CAPTURE_ID, status: "review", storedName });
    expect(restored.resolution).toBeTruthy();
    expect(mediaExists(storedName)).toBe(true);
  });
});

// Item 3: five exits, all of them dead on a deep-linked mount. The diary is
// where this screen's rows live (diary.tsx pushes /capture-review), so it is
// the honest anchor.
describe("exits on a deep-linked mount", () => {
  test("the header back button falls back to the diary", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByLabelText("Go back"));
    expect(safeBack).toHaveBeenCalledWith("/(tabs)/diary");
  });

  test("discarding exits via the same fallback", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByText("Discard capture"));
    await waitFor(() => expect(safeBack).toHaveBeenCalledWith("/(tabs)/diary"));
  });

  test("confirming exits via the same fallback", async () => {
    await render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
    fireEvent.press(await screen.findByText("Confirm"));
    await waitFor(() => expect(safeBack).toHaveBeenCalledWith("/(tabs)/diary"));
  });
});
