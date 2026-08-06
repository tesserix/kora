import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { append, list as listCaptures, markReview } from "@/offline/captureQueue";
import { list as listLogs } from "@/offline/queue";
import CaptureReviewScreen from "../capture-review";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "c1" }),
  router: { back: jest.fn(), push: jest.fn() },
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

// retry: false so a queryFn that throws surfaces immediately.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrap = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

beforeEach(async () => {
  await AsyncStorage.clear();
  await append({
    id: "c1", kind: "photo", storedName: "c1.jpg", fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markReview("c1", RESOLUTION);
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
