import { act, renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { list } from "@/offline/queue";
import { useInstantLog } from "../useInstantLog";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  ApiError: class extends Error {},
}));

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void };
const mockToast: { shown: ToastOptions | null } = { shown: null };
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: (o: ToastOptions) => { mockToast.shown = o; } }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const food = { food_item_id: "f1", name: "Oats", meal_slot: "breakfast", grams: 60 };

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockToast.shown = null;
  onlineManager.setOnline(true);
});

afterEach(() => onlineManager.setOnline(true));

test("undoing a log the server accepted deletes it and leaves the queue alone", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ id: "server-1" });

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown).not.toBeNull());

  await act(async () => { mockToast.shown!.onAction!(); });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith("/v1/logs/server-1", { method: "DELETE" }),
  );
  expect(await list()).toHaveLength(0);
});

// Offline, `created.id` is a queued item's id — a row the server has never
// seen. Firing DELETE /v1/logs/<that id> would 404 (or worse, hit somebody
// else's row) and, critically, leave the item in the queue: the next drain
// would resurrect the meal the user just undid. Undo must reach into the
// queue instead. The discriminant is the value's own shape, NOT "am I online
// right now?" — connectivity can change between the log and the Undo tap.
test("undoing a still-queued log removes it from the queue and sends no DELETE", async () => {
  onlineManager.setOnline(false);

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown).not.toBeNull());
  expect(await list()).toHaveLength(1);

  // Back online before the user taps Undo: the decision must still follow the
  // value, not the current connection.
  onlineManager.setOnline(true);
  await act(async () => { mockToast.shown!.onAction!(); });

  await waitFor(async () => expect(await list()).toHaveLength(0));
  expect(apiFetch).not.toHaveBeenCalled();
});
