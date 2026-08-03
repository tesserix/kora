import { act, renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NetworkError, apiFetch, currentUserId } from "@/lib/api";
import { append, discard, list } from "@/offline/queue";
import { drainLogs } from "@/offline/drainLogs";
import { useInstantLog } from "../useInstantLog";

// Must mirror every member of @/lib/api that useCreateLog reaches for. It
// narrows a failed POST with `isNetworkError(err)`; if that key is missing the
// import is `undefined` and any rejecting apiFetch dies with
// "isNetworkError is not a function" instead of queueing the log.
jest.mock("@/lib/api", () => {
  class MockNetworkError extends Error {}
  return {
    apiFetch: jest.fn(),
    currentUserId: jest.fn(() => "user-a"),
    apiFetchEnvelope: jest.fn(),
    apiFetchMultipart: jest.fn(),
    ApiError: class extends Error {},
    NetworkError: MockNetworkError,
    isNetworkError: (e: unknown) =>
      e instanceof MockNetworkError || (e as { name?: string } | null)?.name === "NetworkError",
  };
});

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void };
const mockToast: { shown: ToastOptions | null } = { shown: null };
// The real queue, with discard wrapped so one test can make it fail.
jest.mock("@/offline/queue", () => {
  const actual = jest.requireActual("@/offline/queue");
  return { ...actual, discard: jest.fn(actual.discard) };
});

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
  (currentUserId as jest.Mock).mockReturnValue("user-a");
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

// The refusal useCreateLog throws when a log cannot be attributed is written as
// user-facing copy, but logFood had no onError — so the user tapped "Your
// usual" and the app did nothing at all. A crafted message nobody reads is
// false confidence.
test("a log that cannot be attributed to anyone tells the user why", async () => {
  (currentUserId as jest.Mock).mockReturnValue(null);
  await AsyncStorage.clear();

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });

  await waitFor(() =>
    expect(mockToast.shown?.message).toBe("Can't save this log — please sign in and try again."),
  );
});

// Anything else that goes wrong gets copy that does not pretend to know the
// cause — the same shape app/log.tsx already shows.
test("any other failed log shows generic copy rather than a server string", async () => {
  (apiFetch as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error("request failed"), { name: "ApiError", status: 500 }),
  );

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });

  await waitFor(() => expect(mockToast.shown?.message).toBe("Couldn't log that. Please try again."));
});

// Exercises the isNetworkError seam through the instant-log path, so this
// file's api mock cannot drift out of step with hooks.ts unnoticed again.
test("a log whose POST dies mid-flight is queued and still offers Undo", async () => {
  (apiFetch as jest.Mock).mockRejectedValueOnce(new NetworkError("socket closed"));

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });

  await waitFor(() => expect(mockToast.shown?.message).toBe("Logged Oats"));
  expect(await list()).toHaveLength(1);
});

// Undo's whole job is to reverse something. If it can't, saying nothing leaves
// the user believing a meal they cancelled is gone when it is still logged.
test("an undo that fails tells the user instead of failing silently", async () => {
  onlineManager.setOnline(false);

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown).not.toBeNull());

  // Storage refuses the write the discard needs. (Injected at the queue
  // boundary rather than by spying on AsyncStorage: jest.spyOn().mockRestore()
  // on the async-storage jest mock resets its methods to no-ops and silently
  // breaks every later test in the file.)
  (discard as jest.Mock).mockRejectedValueOnce(new Error("disk full"));

  await act(async () => { mockToast.shown!.onAction!(); });
  await waitFor(() => expect(mockToast.shown!.message).toBe("Couldn't undo. Try again."));

  // And the log is still queued, which is what the message now promises.
  expect(await list()).toHaveLength(1);
});

// deleteLog.mutate is fire-and-forget inside React Query, so undoLog used to
// resolve whatever the DELETE did and the catch never ran: undo of a log the
// server already has failed just as silently as the discard branch did.
test("an undo whose DELETE fails also tells the user", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "server-1" });

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logFood(food); });
  await waitFor(() => expect(mockToast.shown!.actionLabel).toBe("Undo"));

  (apiFetch as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error("request failed"), { name: "ApiError", status: 500 }),
  );
  await act(async () => { mockToast.shown!.onAction!(); });

  await waitFor(() => expect(mockToast.shown!.message).toBe("Couldn't undo. Try again."));
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

const meal = { name: "Usual lunch", meal_slot: "lunch", items: [{ food_item_id: "f1", grams: 120 }] };

// logMeal is the saved-meal / "usual meal" tap. Its sibling logFood grew an
// onError; logMeal never did, so a failure landed in mutation state nobody
// reads and the tap did nothing at all. Wiring connectivity into onlineManager
// used to hide this behind a permanent pause; now the mutation rejects, so the
// silence is the whole user experience.
test("a saved meal that fails to log tells the user instead of doing nothing", async () => {
  (apiFetch as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error("request failed"), { name: "ApiError", status: 500 }),
  );

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logMeal(meal); });

  await waitFor(() => expect(mockToast.shown?.message).toBe("Couldn't log that. Please try again."));
});

// Same reasoning as logFood's Undo above: an Undo that cannot reverse anything
// must say so, or the user believes a meal they cancelled is gone.
test("an undo of a saved meal whose DELETE fails tells the user", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([{ id: "batch-1" }, { id: "batch-2" }]);

  const { result } = await renderHook(() => useInstantLog(), { wrapper });
  await act(async () => { result.current.logMeal(meal); });
  await waitFor(() => expect(mockToast.shown?.actionLabel).toBe("Undo"));

  (apiFetch as jest.Mock).mockRejectedValue(
    Object.assign(new Error("request failed"), { name: "ApiError", status: 500 }),
  );
  await act(async () => { mockToast.shown!.onAction!(); });

  await waitFor(() => expect(mockToast.shown!.message).toBe("Couldn't undo. Try again."));
});
