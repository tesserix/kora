import { act, renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { append, list } from "@/offline/queue";
import { drainLogs } from "@/offline/drainLogs";
import { useInstantLog } from "../useInstantLog";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  ApiError: class extends Error {},
  // useCreateLog does `err instanceof NetworkError`; without it here the class
  // is undefined and any rejecting apiFetch throws a TypeError instead.
  NetworkError: class NetworkError extends Error {},
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
  // An unrelated pending item, so "leaves the queue alone" is a claim that can
  // fail. Against an empty queue the final assertion holds no matter what Undo
  // does — including discarding the wrong item, or nothing at all.
  await append(
    { food_item_id: "f9", meal_slot: "dinner", source: "manual", quantity_grams: 10, logged_at: "2026-08-01T18:00:00.000Z" },
    "bystander-1",
    "user-a",
  );

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown).not.toBeNull());

  await act(async () => { mockToast.shown!.onAction!(); });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith("/v1/logs/server-1", { method: "DELETE" }),
  );
  expect((await list()).map((i) => i.id)).toEqual(["bystander-1"]);
});

// Offline, `created.id` is a queued item's id — a row the server has never
// seen. Firing DELETE /v1/logs/<that id> would 404 (or worse, hit somebody
// else's row) and, critically, leave the item in the queue: the next drain
// would resurrect the meal the user just undid. Undo must reach into the
// queue instead — and never decide by "am I online right now?", since
// connectivity can change between the log and the Undo tap.
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

// The toast lives for five seconds; a reconnect drain can easily land inside
// that window. Once it does, the captured value STILL looks queued, but the
// item is gone from the queue and the server row exists. Deciding on the
// captured shape would call discard() on nothing and never send the DELETE —
// Undo would silently do nothing and the meal would stay logged. Membership in
// the queue at the moment Undo is tapped is the only honest question.
test("undoing after a reconnect drain has already sent the log DELETEs the server row", async () => {
  onlineManager.setOnline(false);

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown).not.toBeNull());
  const queuedId = (await list())[0].id;

  // Reconnect while the Undo toast is still on screen: the drain sends the log
  // and removes it from the queue.
  onlineManager.setOnline(true);
  (apiFetch as jest.Mock).mockResolvedValue({ id: queuedId });
  await drainLogs(new QueryClient());
  expect(await list()).toHaveLength(0);

  await act(async () => { mockToast.shown!.onAction!(); });

  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(`/v1/logs/${queuedId}`, { method: "DELETE" }),
  );
});
