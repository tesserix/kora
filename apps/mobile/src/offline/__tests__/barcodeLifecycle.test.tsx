import { act, renderHook } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useResolveBarcode } from "@/api/hooks";
import { OfflineUnknownBarcodeError } from "../cachedResolution";
import { enqueueBarcodeCapture } from "../enqueueCapture";
import { list as captures } from "../captureQueue";
import { list as logs } from "../queue";
import { drainCaptures } from "../drainCaptures";
import { upsertFoods } from "../foodCache";
import type { FoodItem } from "@/api/types";

jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: {
    authStateReady: async () => {},
    currentUser: { uid: "barcode-test-user", getIdToken: async () => "test-token" },
  },
}));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(), signOut: jest.fn() }));

const code = "5000112637922";
const food = { id: "barcode-food", name: "Test food", barcode: code, serving_grams: 60 } as FoodItem;
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  global.fetch = jest.fn();
});
afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
});

test("a native transport failure persists one unseen scan and drains with its original time", async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Network request failed"));
  const { result, unmount } = await renderHook(() => useResolveBarcode(), { wrapper });
  const capturedAt = "2026-10-11T01:00:00.000Z";
  let error: unknown;
  await act(async () => {
    try { await result.current.mutateAsync({ input: code }); } catch (caught) { error = caught; }
  });
  expect(error).toBeInstanceOf(OfflineUnknownBarcodeError);
  await enqueueBarcodeCapture(code, "lunch", capturedAt);
  await enqueueBarcodeCapture(code, "lunch", capturedAt);
  expect(await captures()).toHaveLength(1);
  await unmount();
  const stored = await AsyncStorage.getItem("kora.captureQueue");
  expect(JSON.parse(stored!)[0]).toMatchObject({ code, capturedAt, ownerId: "barcode-test-user" });

  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: {
      tier: "auto",
      candidates: [{ item: food, portion_grams: 60, tier: "auto" }],
    } }),
  });
  await drainCaptures(client);
  await drainCaptures(client);
  expect(await captures()).toEqual([]);
  const queuedLogs = await logs();
  expect(queuedLogs).toHaveLength(1);
  expect(queuedLogs[0].payload).toMatchObject({
    food_item_id: food.id, source: "ai_barcode", logged_at: capturedAt, meal_slot: "lunch",
  });
});

test("a seen barcode resolves offline without entering the capture queue", async () => {
  await upsertFoods([food]);
  onlineManager.setOnline(false);
  const { result } = await renderHook(() => useResolveBarcode(), { wrapper });
  await act(async () => {
    const resolution = await result.current.mutateAsync({ input: code });
    expect(resolution.candidates[0].item.id).toBe(food.id);
    expect(resolution.tier).toBe("confirm");
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(await captures()).toEqual([]);
});
