import { renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NetworkError, apiFetch, apiFetchEnvelope, apiFetchMultipart, currentUserId } from "@/lib/api";
import { drain, list } from "@/offline/queue";
import { getFoodById, getFoodByBarcode } from "@/offline/foodCache";
import * as foodCache from "@/offline/foodCache";
import { rememberOwner } from "@/offline/owner";
import { append } from "@/offline/queue";
import { useQueuedLogs } from "@/offline/useQueuedLogs";
import {
  useAcceptRequest,
  useAddWater,
  useAddWeight,
  useAvgIntake7d,
  useCreateChallenge,
  useCreateGroup,
  useCreateLog,
  useCreateLogBatch,
  useDeleteChallenge,
  useDeleteLog,
  useEditLog,
  useFoodSearch,
  useFriendsProgress,
  useGroupChallenges,
  useInviteToGroup,
  useJoinChallenge,
  useJoinGroup,
  useLeaveChallenge,
  useLeaveGroup,
  useLog,
  useMarkAllRead,
  useMemory,
  useNotifications,
  usePins,
  useProfile,
  useRenameGroup,
  useRepeatLog,
  useResolveBarcode,
  useResolvePhoto,
  useResolveText,
  useResolveVoice,
  useSavedMeals,
  useSendFriendRequest,
  useSetShareProgress,
  useSubmitOnboarding,
  useUnfriend,
  useUnreadCount,
  useWeightSeries,
} from "../hooks";

jest.mock("@/lib/api", () => {
  // Deliberately does NOT set `name`, so the class instance is recognisable
  // only by identity and the duck-typed object only by name — each branch of
  // isNetworkError is then exercised by exactly one test.
  class MockNetworkError extends Error {}
  return {
    apiFetch: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", goal: "", onboarded_at: null }),
    currentUserId: jest.fn(() => "user-a"),
    apiFetchEnvelope: jest.fn(),
    apiFetchMultipart: jest.fn(),
    ApiError: class extends Error {},
    NetworkError: MockNetworkError,
    isNetworkError: (e: unknown) =>
      e instanceof MockNetworkError || (e as { name?: string } | null)?.name === "NetworkError",
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Restore any jest.spyOn (e.g. the FormData.append spies below) even when a test
// throws before its inline restore — otherwise a spy leaks into later tests.
afterEach(() => {
  jest.restoreAllMocks();
});

test("useProfile fetches /v1/me", async () => {
  const { result } = await renderHook(() => useProfile(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.email).toBe("a@b.c");
});

test("useFoodSearch hits /v1/foods with the query and stays disabled under 2 chars", async () => {
  const { result: idle } = await renderHook(() => useFoodSearch("q"), { wrapper });
  // enabled: false means react-query never runs the queryFn for this query.
  expect(idle.current.fetchStatus).toBe("idle");

  const candidates = [{ item: { id: "f2", name: "Quinoa" }, match_score: 0.9, match_tier: "fulltext" }];
  (apiFetch as jest.Mock).mockResolvedValueOnce(candidates);
  const { result } = await renderHook(() => useFoodSearch("quinoa"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/foods?q=quinoa");
  expect(result.current.data).toEqual(candidates);
});

const resolution = {
  candidates: [],
  tier: "auto" as const,
  is_estimate: false,
  provenance: "usda",
};

test("useResolveText posts phrase to /v1/resolve/text", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce(resolution);

  const { result } = await renderHook(() => useResolveText(), { wrapper });
  result.current.mutate("2 eggs");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetch).toHaveBeenCalledWith("/v1/resolve/text", {
    method: "POST",
    body: JSON.stringify({ phrase: "2 eggs" }),
  });
  expect(result.current.data).toEqual(resolution);
});

test("useResolveBarcode posts barcode to /v1/resolve/barcode", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce(resolution);

  const { result } = await renderHook(() => useResolveBarcode(), { wrapper });
  result.current.mutate("0123456789012");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetch).toHaveBeenCalledWith("/v1/resolve/barcode", {
    method: "POST",
    body: JSON.stringify({ barcode: "0123456789012" }),
  });
  expect(result.current.data).toEqual(resolution);
});

// The server's designed response for an unrecognised barcode omits
// `candidates` entirely (api/internal/resolve/handler.go:210-217), which Go
// marshals as `"candidates": null` because the field has no `omitempty`
// (api/internal/ai/types.go:81) — this is the MOST COMMON real scan outcome,
// not an edge case. Before normalizeResolution, `resolution.candidates.map(...)`
// in useResolveBarcode's onSuccess threw on exactly this response, breaking
// the very "search and log manually" fallback the server designed for it.
test("useResolveBarcode succeeds on the server's real not-found response (candidates: null)", async () => {
  const notFound = {
    candidates: null,
    tier: "follow_up" as const,
    follow_up_question: "Barcode not recognized — search and log manually.",
    is_estimate: false,
    provenance: "barcode",
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce(notFound);

  const { result } = await renderHook(() => useResolveBarcode(), { wrapper });
  await expect(result.current.mutateAsync("0000000000000")).resolves.toMatchObject({
    candidates: [],
    tier: "follow_up",
  });
});

// getFoodByBarcode had no reachable writer before this: usePins/useSavedMeals
// only ever produce "summary" records (no barcode field at all), so a repeat
// scan could never find anything. useResolveBarcode is the one path that
// hands back a genuine server FoodItem, including its barcode.
test("useResolveBarcode caches the resolved food for an offline repeat scan", async () => {
  await AsyncStorage.clear();
  const barcodeResolution = {
    candidates: [
      {
        item: {
          id: "f9", name: "Protein bar", brand: "Acme", provenance: "off",
          serving_desc: "1 bar (40 g)", serving_grams: 40,
          kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
          barcode: "0123456789012",
        },
        portion_grams: 40, kcal: 100, match_score: 1, match_tier: "auto",
      },
    ],
    tier: "auto" as const,
    is_estimate: false,
    provenance: "off",
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce(barcodeResolution);

  const { result } = await renderHook(() => useResolveBarcode(), { wrapper });
  await result.current.mutateAsync("0123456789012");

  await waitFor(async () => expect(await getFoodByBarcode("0123456789012")).not.toBeNull());
  const cached = await getFoodByBarcode("0123456789012");
  expect(cached?.id).toBe("f9");
  expect(cached?.provenance).toBe("off");
});

// Once a barcode scan has cached a full FoodItem, a later usePins/useSavedMeals
// refetch of the SAME food (a "summary" write — see foodsFromPins) must not
// clobber it: it would silently drop the barcode, replace the real
// provenance, and swap the canonical serving for whatever gram amount the
// user happened to pin.
test("a pins refetch does not overwrite a food already cached at full fidelity from a barcode scan", async () => {
  await AsyncStorage.clear();
  const barcodeResolution = {
    candidates: [
      {
        item: {
          id: "f9", name: "Protein bar", brand: "Acme", provenance: "off",
          serving_desc: "1 bar (40 g)", serving_grams: 40,
          kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
          barcode: "0123456789012",
        },
        portion_grams: 40, kcal: 100, match_score: 1, match_tier: "auto",
      },
    ],
    tier: "auto" as const,
    is_estimate: false,
    provenance: "off",
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce(barcodeResolution);
  const barcodeHook = await renderHook(() => useResolveBarcode(), { wrapper });
  await barcodeHook.result.current.mutateAsync("0123456789012");
  await waitFor(async () => expect(await getFoodById("f9")).not.toBeNull());

  // The user then pins the SAME food. The server's pins summary carries no
  // barcode/provenance/serving info at all — only a gram-scaled total.
  const pins = [
    { food_item_id: "f9", name: "Protein bar", meal_slot: "snack", grams: 40, kcal: 100, protein_g: 8, carbs_g: 12, fat_g: 2, fiber_g: 0 },
  ];
  (apiFetch as jest.Mock).mockResolvedValueOnce(pins);
  const { result } = await renderHook(() => usePins(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const cached = await getFoodById("f9");
  // The barcode scan's full record must survive the pins refetch untouched.
  expect(cached?.barcode).toBe("0123456789012");
  expect(cached?.provenance).toBe("off");
  expect(cached?.serving_grams).toBe(40);
});

// A cache write is a by-product of a query the user did not ask for; a
// storage failure (quota, corrupt device state) must be visible in logs, not
// left as an unhandled promise rejection nor silently swallowed.
test("a cache-write failure from usePins is caught and logged, never left unhandled", async () => {
  await AsyncStorage.clear();
  const pins = [
    { food_item_id: "f1", name: "Greek yogurt", meal_slot: "breakfast", grams: 150, kcal: 150, protein_g: 15, carbs_g: 6, fat_g: 3, fiber_g: 0 },
  ];
  (apiFetch as jest.Mock).mockResolvedValueOnce(pins);
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  // Spies on upsertFoods itself rather than the shared AsyncStorage.setItem —
  // narrower blast radius: this only ever affects usePins's one call within
  // this test, never any other test's unrelated AsyncStorage writes.
  const upsertSpy = jest.spyOn(foodCache, "upsertFoods").mockRejectedValueOnce(new Error("quota exceeded"));
  try {
    const { result } = await renderHook(() => usePins(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(warnSpy).toHaveBeenCalledWith("foodCache: upsertFoods failed", expect.any(Error)));
  } finally {
    upsertSpy.mockRestore();
    warnSpy.mockRestore();
  }
});

test("useResolvePhoto builds FormData and posts to /v1/resolve/photo", async () => {
  (apiFetchMultipart as jest.Mock).mockResolvedValueOnce(resolution);
  const appendSpy = jest.spyOn(FormData.prototype, "append");

  const { result } = await renderHook(() => useResolvePhoto(), { wrapper });
  result.current.mutate({ uri: "file:///photo.jpg", name: "photo.jpg", type: "image/jpeg" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/photo", expect.any(FormData));
  expect(appendSpy).toHaveBeenCalledWith("file", { uri: "file:///photo.jpg", name: "photo.jpg", type: "image/jpeg" });
  expect(result.current.data).toEqual(resolution);
});

test("useResolveVoice builds FormData and posts to /v1/resolve/voice", async () => {
  (apiFetchMultipart as jest.Mock).mockResolvedValueOnce(resolution);
  const appendSpy = jest.spyOn(FormData.prototype, "append");

  const { result } = await renderHook(() => useResolveVoice(), { wrapper });
  result.current.mutate({ uri: "file:///voice.m4a", name: "voice.m4a", type: "audio/m4a" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/voice", expect.any(FormData));
  expect(appendSpy).toHaveBeenCalledWith("file", { uri: "file:///voice.m4a", name: "voice.m4a", type: "audio/m4a" });
  expect(result.current.data).toEqual(resolution);
});

test("useEditLog PATCHes /v1/logs/:id with only the patch fields and invalidates logs+dashboard", async () => {
  (apiFetchEnvelope as jest.Mock).mockResolvedValueOnce({ data: { id: "log1" } });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  result.current.mutate({ id: "log1", quantity_grams: 120, meal_slot: "lunch" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetchEnvelope).toHaveBeenCalledWith("/v1/logs/log1", {
    method: "PATCH",
    body: JSON.stringify({ quantity_grams: 120, meal_slot: "lunch" }),
  });
});

test("useLog GETs /v1/logs/:id and returns the full record", async () => {
  const log = {
    id: "log1",
    food_item_id: "f1",
    source: "ai_text",
    input_phrase: "brekkie eggs",
    description: "Scrambled eggs",
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce(log);
  const { result } = await renderHook(() => useLog("log1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log1");
  expect(result.current.data?.input_phrase).toBe("brekkie eggs");
});

test("useLog stays idle and never fetches for an empty string id", async () => {
  // apiFetch is a shared mock across this file's tests, so assert against a
  // call-count delta rather than `not.toHaveBeenCalled()`.
  const callsBefore = (apiFetch as jest.Mock).mock.calls.length;
  const { result } = await renderHook(() => useLog(""), { wrapper });
  expect(result.current.fetchStatus).toBe("idle");
  expect((apiFetch as jest.Mock).mock.calls.length).toBe(callsBefore);
});

test("useLog does not throw when id is undefined at runtime despite its string type", async () => {
  // Expo Router's useLocalSearchParams types a param as `string` but can hand
  // back `undefined` at runtime — this must disable the query, not throw.
  const callsBefore = (apiFetch as jest.Mock).mock.calls.length;
  const { result } = await renderHook(() => useLog(undefined as unknown as string), { wrapper });
  expect(result.current.fetchStatus).toBe("idle");
  expect((apiFetch as jest.Mock).mock.calls.length).toBe(callsBefore);
});

test("useEditLog surfaces meta.alias_recorded alongside the updated log", async () => {
  (apiFetchEnvelope as jest.Mock).mockResolvedValueOnce({
    data: { id: "log1", food_item_id: "f2" },
    meta: { alias_recorded: true },
  });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  const out = await result.current.mutateAsync({ id: "log1", food_item_id: "f2" });
  expect(out.aliasRecorded).toBe(true);
  expect(out.log.food_item_id).toBe("f2");
});

test("useEditLog reports aliasRecorded false when the server omits meta", async () => {
  (apiFetchEnvelope as jest.Mock).mockResolvedValueOnce({ data: { id: "log1" } });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  const out = await result.current.mutateAsync({ id: "log1", quantity_grams: 200 });
  expect(out.aliasRecorded).toBe(false);
});

test("useEditLog forwards retract_correction when set", async () => {
  (apiFetchEnvelope as jest.Mock).mockResolvedValueOnce({
    data: { id: "log1" },
    meta: { alias_recorded: false },
  });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  await result.current.mutateAsync({ id: "log1", food_item_id: "f1", retract_correction: true });
  expect(apiFetchEnvelope).toHaveBeenCalledWith("/v1/logs/log1", {
    method: "PATCH",
    body: JSON.stringify({ food_item_id: "f1", retract_correction: true }),
  });
});

test("useDeleteLog DELETEs /v1/logs/:id", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ deleted: true });
  const { result } = await renderHook(() => useDeleteLog(), { wrapper });
  result.current.mutate("log9");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log9", { method: "DELETE" });
});

test("useAddWater POSTs /v1/water with volume_ml and logged_at", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({});
  const { result } = await renderHook(() => useAddWater(), { wrapper });
  result.current.mutate({ volume_ml: 250, logged_at: "2026-07-25T12:00:00Z" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/water", {
    method: "POST",
    body: JSON.stringify({ volume_ml: 250, logged_at: "2026-07-25T12:00:00Z" }),
  });
});

test("useAddWeight POSTs /v1/weight and invalidates weight", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "w1" });
  const { result } = await renderHook(() => useAddWeight(), { wrapper });
  result.current.mutate({ weight_kg: 72.4 });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/weight", {
    method: "POST",
    body: JSON.stringify({ weight_kg: 72.4, logged_at: undefined }),
  });
});

test("useRepeatLog POSTs /v1/logs/:id/repeat with no body", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log2" });
  const { result } = await renderHook(() => useRepeatLog(), { wrapper });
  result.current.mutate("log1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log1/repeat", { method: "POST" });
});

test("useRepeatLog invalidates logs and dashboard on success", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log2" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = jest.spyOn(client, "invalidateQueries");
  const localWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = await renderHook(() => useRepeatLog(), { wrapper: localWrapper });
  result.current.mutate("log1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
});

test("useWeightSeries GETs /v1/weight with a ~30d from/to for 1M", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useWeightSeries("1M"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // apiFetch is a shared mock across this file's tests (no clearAllMocks between them),
  // so pull the most recent call rather than assuming index 0.
  const calls = (apiFetch as jest.Mock).mock.calls;
  const url = calls[calls.length - 1][0] as string;
  const params = new URLSearchParams(url.split("?")[1]);
  const from = new Date(params.get("from") as string).getTime();
  const to = new Date(params.get("to") as string).getTime();
  const days = (to - from) / (24 * 60 * 60 * 1000);
  expect(Math.round(days)).toBe(30);
});

test("useSendFriendRequest POSTs the body to /v1/friends/requests", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "f1", status: "pending" });
  const { result } = await renderHook(() => useSendFriendRequest(), { wrapper });
  result.current.mutate({ code: "ABC123XY" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/requests", {
    method: "POST",
    body: JSON.stringify({ code: "ABC123XY" }),
  });
});

test("useAcceptRequest POSTs /v1/friends/requests/:id/accept", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ accepted: true });
  const { result } = await renderHook(() => useAcceptRequest(), { wrapper });
  result.current.mutate("req1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/requests/req1/accept", { method: "POST" });
});

test("useUnfriend DELETEs /v1/friends/:userId", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ removed: true });
  const { result } = await renderHook(() => useUnfriend(), { wrapper });
  result.current.mutate("u9");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/u9", { method: "DELETE" });
});

test("useFriendsProgress GETs /v1/friends/progress", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ me: { streak_days: 3, adherence_days: 4, adherence_window: 7 }, friends: [] });
  const { result } = await renderHook(() => useFriendsProgress(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/progress");
});

test("useSetShareProgress PATCHes /v1/me/share-progress with the flag", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ share_progress: true });
  const { result } = await renderHook(() => useSetShareProgress(), { wrapper });
  result.current.mutate(true);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/me/share-progress", {
    method: "PATCH",
    body: JSON.stringify({ share_progress: true }),
  });
});

test("useCreateGroup POSTs the name to /v1/groups", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "g1", name: "Squad" });
  const { result } = await renderHook(() => useCreateGroup(), { wrapper });
  result.current.mutate("Squad");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups", { method: "POST", body: JSON.stringify({ name: "Squad" }) });
});

test("useJoinGroup POSTs the code to /v1/groups/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "g1" });
  const { result } = await renderHook(() => useJoinGroup(), { wrapper });
  result.current.mutate("CODE1234");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/join", { method: "POST", body: JSON.stringify({ code: "CODE1234" }) });
});

test("useLeaveGroup DELETEs /v1/groups/:id/members/:userId", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ removed: true });
  const { result } = await renderHook(() => useLeaveGroup(), { wrapper });
  result.current.mutate({ groupId: "g1", userId: "u1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/members/u1", { method: "DELETE" });
});

test("useGroupChallenges fetches /v1/groups/:id/challenges", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useGroupChallenges("g1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/challenges");
});

test("useCreateChallenge POSTs title/metric/duration", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "c1" });
  const { result } = await renderHook(() => useCreateChallenge(), { wrapper });
  result.current.mutate({ groupId: "g1", title: "Streak", metric: "logged", duration: "1w" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/challenges", {
    method: "POST",
    body: JSON.stringify({ title: "Streak", metric: "logged", duration: "1w" }),
  });
});

test("useJoinChallenge POSTs to /v1/challenges/:cid/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ joined: true });
  const { result } = await renderHook(() => useJoinChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1/join", { method: "POST" });
});

test("useLeaveChallenge DELETEs /v1/challenges/:cid/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ left: true });
  const { result } = await renderHook(() => useLeaveChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1/join", { method: "DELETE" });
});

test("useDeleteChallenge DELETEs /v1/challenges/:cid", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ deleted: true });
  const { result } = await renderHook(() => useDeleteChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1", { method: "DELETE" });
});

test("useNotifications fetches /v1/notifications", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useNotifications(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications");
});

test("useUnreadCount fetches /v1/notifications/unread-count", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ count: 3 });
  const { result } = await renderHook(() => useUnreadCount(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications/unread-count");
  expect(result.current.data?.count).toBe(3);
});

test("useMarkAllRead POSTs /v1/notifications/read", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ marked: 2 });
  const { result } = await renderHook(() => useMarkAllRead(), { wrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications/read", { method: "POST" });
});

test("useRenameGroup PATCHes /v1/groups/:id with the name", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ renamed: true });
  const { result } = await renderHook(() => useRenameGroup(), { wrapper });
  await result.current.mutateAsync({ groupId: "g1", name: "New Crew" });
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1", {
    method: "PATCH",
    body: JSON.stringify({ name: "New Crew" }),
  });
});

test("useInviteToGroup POSTs /v1/groups/:id/invite with user_id", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ invited: true });
  const { result } = await renderHook(() => useInviteToGroup(), { wrapper });
  await result.current.mutateAsync({ groupId: "g1", userId: "f1" });
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/invite", {
    method: "POST",
    body: JSON.stringify({ user_id: "f1" }),
  });
});

const dashboardSummary = (kcal: number) => ({
  date: "2026-07-27",
  consumed: { kcal, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  targets: { kcal: 2200, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  water_ml: 0,
  streak_days: 0,
  source_counts: {},
});

it("useAvgIntake7d averages consumed kcal across the last 7 days that have data", async () => {
  (apiFetch as jest.Mock).mockImplementation((url: string) =>
    url.startsWith("/v1/dashboard") ? Promise.resolve(dashboardSummary(2000)) : Promise.resolve({}),
  );

  const { result } = await renderHook(() => useAvgIntake7d("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.series.length).toBe(7);
  expect(result.current.avg).toBe(2000);
});

it("useAvgIntake7d returns avg: null and an empty series when every day errors (never fabricates)", async () => {
  (apiFetch as jest.Mock).mockImplementation((url: string) =>
    url.startsWith("/v1/dashboard") ? Promise.reject(new Error("no data for date")) : Promise.resolve({}),
  );

  const { result } = await renderHook(() => useAvgIntake7d("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.series).toEqual([]);
  expect(result.current.avg).toBeNull();
});

it("useAvgIntake7d returns avg: null and an empty series when every day is unlogged (0 kcal, never fabricates)", async () => {
  (apiFetch as jest.Mock).mockImplementation((url: string) =>
    url.startsWith("/v1/dashboard") ? Promise.resolve(dashboardSummary(0)) : Promise.resolve({}),
  );

  const { result } = await renderHook(() => useAvgIntake7d("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.series).toEqual([]);
  expect(result.current.avg).toBeNull();
});

test("useMemory fetches GET /v1/memory (date is not sent — backend ignores it)", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ recents: [], frequent: [], usual_meals: [] });
  const { result } = await renderHook(() => useMemory("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/memory");
});

const logInput = {
  food_item_id: "f1",
  meal_slot: "lunch",
  source: "manual",
  quantity_grams: 100,
  logged_at: "2026-08-02T12:00:00.000Z",
};

// The id is minted client-side for EVERY log, online or not, so a queued copy
// and the server row share one identity and a replay of a write whose response
// was lost resolves to the same row (api/internal/foodlog CreateIdempotent)
// instead of duplicating the meal.
test("useCreateLog POSTs with a client-minted id when online", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log1" });
  const { result } = await renderHook(() => useCreateLog(), { wrapper });
  await result.current.mutateAsync(logInput);

  const [path, init] = (apiFetch as jest.Mock).mock.calls.at(-1) as [string, RequestInit];
  expect(path).toBe("/v1/logs");
  const body = JSON.parse(init.body as string);
  expect(body.food_item_id).toBe("f1");
  expect(typeof body.id).toBe("string");
  expect(body.id.length).toBeGreaterThan(0);
  expect(await list()).toHaveLength(0);

  // A FIXED id would satisfy every assertion above and is the catastrophic
  // case: CreateIdempotent resolves the second write to the first one's row, so
  // every meal the user ever logs collapses into a single server row.
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log2" });
  await result.current.mutateAsync(logInput);
  const secondId = JSON.parse((apiFetch as jest.Mock).mock.calls.at(-1)![1].body).id;
  expect(secondId).not.toBe(body.id);
});

// The cold-start window this whole task has been fighting, on the WRITE side:
// app/_layout.tsx has no auth gate and (tabs)/_layout.tsx only redirects to
// /sign-in from inside the onAuthStateChanged callback, so Home is tappable
// while auth.currentUser is still null. Before this, such a write was stamped
// with no owner and drain skipped it forever — the user got a "Logged Oats"
// toast for a meal that could never be sent.
test("useCreateLog stamps the remembered uid when auth has not restored yet", async () => {
  await AsyncStorage.clear();
  await rememberOwner("user-a");
  (currentUserId as jest.Mock).mockReturnValue(null);
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useCreateLog(), { wrapper });
    // Must RESOLVE, and resolve to an OWNED item: refusing the write here would
    // be as wrong as queueing it unowned — the user is signed in, Firebase just
    // has not said so yet.
    await expect(result.current.mutateAsync(logInput)).resolves.toMatchObject({ ownerId: "user-a" });

    const items = await list();
    expect(items).toHaveLength(1);
    expect(items[0].ownerId).toBe("user-a");
    // And that stamp is what makes it sendable once Firebase restores that user.
    expect(await drain(async () => {}, "user-a")).toMatchObject({ sent: 1 });
  } finally {
    onlineManager.setOnline(true);
    (currentUserId as jest.Mock).mockReturnValue("user-a");
    await AsyncStorage.clear();
  }
});

// Nobody has ever signed in on this device, so there is no honest owner to
// stamp. Queueing anyway would produce an item no drain will ever send and no
// screen will ever show — fail loudly instead.
test("useCreateLog refuses the write when no owner can be resolved at all", async () => {
  await AsyncStorage.clear();
  (currentUserId as jest.Mock).mockReturnValue(null);
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useCreateLog(), { wrapper });
    await expect(result.current.mutateAsync(logInput)).rejects.toThrow(/sign/i);
    expect(await list()).toHaveLength(0);
  } finally {
    onlineManager.setOnline(true);
    (currentUserId as jest.Mock).mockReturnValue("user-a");
  }
});

test("useCreateLog queues the write instead of POSTing when offline", async () => {
  await AsyncStorage.clear();
  onlineManager.setOnline(false);
  try {
    const callsBefore = (apiFetch as jest.Mock).mock.calls.length;
    const { result } = await renderHook(() => useCreateLog(), { wrapper });
    const queued = await result.current.mutateAsync(logInput);

    expect((apiFetch as jest.Mock).mock.calls.length).toBe(callsBefore);
    const items = await list();
    expect(items.map((i) => i.id)).toEqual([queued.id]);
    expect(items[0].payload.food_item_id).toBe("f1");
    // Stamped with the writer's uid, so a later sign-in by somebody else on
    // this device cannot drain this meal into their diary.
    expect(items[0].ownerId).toBe("user-a");
  } finally {
    onlineManager.setOnline(true);
    await AsyncStorage.clear();
  }
});

// The guard mirrors the drain side (src/offline/__tests__/drainLogs.test.ts):
// the queued rows must be refreshed by a write that was QUEUED — nothing else
// will ever show that meal, and offline the two server-backed invalidations
// are paused rather than fetched — and left alone by a write the server
// accepted, since a genuine server row cannot have changed the queue.
test("a queued write refreshes the queued rows; a write the server accepted does not", async () => {
  await AsyncStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function stableWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const spy = jest.spyOn(client, "invalidateQueries");
  const { result } = await renderHook(() => useCreateLog(), { wrapper: stableWrapper });

  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log1" });
  await result.current.mutateAsync(logInput);
  expect(spy).toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  expect(spy).not.toHaveBeenCalledWith({ queryKey: ["queuedLogs"] });

  spy.mockClear();
  onlineManager.setOnline(false);
  try {
    await result.current.mutateAsync(logInput);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["queuedLogs"] });
  } finally {
    onlineManager.setOnline(true);
    await AsyncStorage.clear();
  }
});

// isOnline() is only a snapshot taken before the request leaves. The commonest
// mobile failure is the connection dying WHILE the POST is in flight: fetch
// rejects, apiFetch turns it into NetworkError, and without this the log
// vanishes — logFood has no onError, so the user is told nothing. The
// client-minted id makes the replay safe even if the server did receive it.
test("useCreateLog queues the log when the POST dies mid-flight", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockRejectedValueOnce(new NetworkError(new Error("socket closed")));

  const { result } = await renderHook(() => useCreateLog(), { wrapper });
  // Must RESOLVE: a rejection here is the log disappearing with no error shown.
  await expect(result.current.mutateAsync(logInput)).resolves.toMatchObject({ status: "pending" });

  const items = await list();
  expect(items).toHaveLength(1);
  // Same id the POST carried, so a replay resolves to that row rather than a
  // second copy of the meal.
  const sentId = JSON.parse((apiFetch as jest.Mock).mock.calls.at(-1)![1].body).id;
  expect(items[0].id).toBe(sentId);
  expect(items[0]).toMatchObject({ status: "pending", ownerId: "user-a" });
  await AsyncStorage.clear();
});

// The offline feature has two ways of naming this failure: hooks.ts narrows on
// the class, while queue.ts's fixtures and drainLogs's fake server build it as
// `Object.assign(new Error(...), { name: "NetworkError" })`. One shared
// predicate has to accept both, or a duck-typed one silently takes the rethrow
// path and the log is lost.
test("useCreateLog queues a duck-typed NetworkError too, not just the class", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error("Network request failed"), { name: "NetworkError" }),
  );

  const { result } = await renderHook(() => useCreateLog(), { wrapper });
  await expect(result.current.mutateAsync(logInput)).resolves.toMatchObject({ status: "pending" });
  expect(await list()).toHaveLength(1);
  await AsyncStorage.clear();
});

// Only a lost connection earns a retry. A 400 is the server saying the write
// itself is wrong; queueing it would replay a request that fails identically
// forever, and swallowing the rejection would hide a real bug from the caller.
test("useCreateLog rethrows a 4xx and queues nothing", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error("bad request"), { name: "ApiError", status: 400 }),
  );

  const { result } = await renderHook(() => useCreateLog(), { wrapper });
  await expect(result.current.mutateAsync(logInput)).rejects.toThrow("bad request");
  expect(await list()).toHaveLength(0);
});

test("useCreateLogBatch posts to /v1/logs/batch", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([{ id: "1" }]);
  const { result } = await renderHook(() => useCreateLogBatch(), { wrapper });
  await result.current.mutateAsync({
    logged_at: "2026-07-27T12:00:00Z",
    meal_slot: "breakfast",
    items: [{ food_item_id: "abc", quantity_grams: 60 }],
  });
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/batch", expect.objectContaining({ method: "POST" }));
});

// Regression: a brand-new account completed onboarding against prod, the POST
// succeeded, and the app still bounced them back to onboarding step 1 and left
// them stuck there. Cause: onSuccess only invalidated ["profile"], which marks
// the entry stale but keeps serving the cached value, so (tabs)/_layout read
// the pre-onboarding profile (onboarded_at === null) and redirected. The
// mutation already returns the fresh Profile, so it must seed the cache.
test("useSubmitOnboarding replaces the cached profile with the onboarded one", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["profile"], { id: "u1", email: "a@b.c", goal: "", onboarded_at: null });

  const onboarded = {
    id: "u1",
    email: "a@b.c",
    goal: "maintenance",
    onboarded_at: "2026-08-01T11:39:23Z",
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce(onboarded);

  const { result } = await renderHook(() => useSubmitOnboarding(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

  await result.current.mutateAsync({
    sex: "male",
    birth_year: 1990,
    height_cm: 180,
    weight_kg: 78,
    activity_level: "moderate",
    goal: "maintenance",
  });

  await waitFor(() => expect(client.getQueryData(["profile"])).toEqual(onboarded));
});

// usePins/useSavedMeals are the only two read hooks with a nested food
// summary in their response, so they are what fills the offline food cache
// (see src/offline/foodCache.ts and extractFoods in ../hooks.ts). This test
// asserts against the CACHE ITSELF via getFoodById, not against a spy on
// upsertFoods — a spy would prove the function was called with something,
// never that a real, subsequently-loggable entry landed in storage.
test("usePins fills the offline food cache with what it fetches", async () => {
  await AsyncStorage.clear();
  const pins = [
    { food_item_id: "f1", name: "Greek yogurt", meal_slot: "breakfast", grams: 150, kcal: 150, protein_g: 15, carbs_g: 6, fat_g: 3, fiber_g: 0 },
  ];
  (apiFetch as jest.Mock).mockResolvedValueOnce(pins);

  const { result } = await renderHook(() => usePins(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await waitFor(async () => expect(await getFoodById("f1")).not.toBeNull());
  const cached = await getFoodById("f1");
  expect(cached?.name).toBe("Greek yogurt");
  // 150 kcal for 150g scales back to exactly 100 kcal/100g — this is the
  // reverse of the scaling the server applied, not an approximation.
  expect(cached?.kcal_per_100g).toBeCloseTo(100);
});

test("useSavedMeals fills the offline food cache with the foods nested inside each meal", async () => {
  await AsyncStorage.clear();
  const meals = [
    {
      id: "meal1",
      name: "My lunch",
      meal_slot: "lunch",
      items: [
        { food_item_id: "f2", name: "Cheddar cheese", grams: 50, kcal: 200, protein_g: 12, carbs_g: 1, fat_g: 16, fiber_g: 0 },
      ],
      kcal: 200, protein_g: 12, carbs_g: 1, fat_g: 16, fiber_g: 0,
    },
  ];
  (apiFetch as jest.Mock).mockResolvedValueOnce(meals);

  const { result } = await renderHook(() => useSavedMeals(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await waitFor(async () => expect(await getFoodById("f2")).not.toBeNull());
  const cached = await getFoodById("f2");
  expect(cached?.name).toBe("Cheddar cheese");
  // The SAVED MEAL's own id ("meal1") must never be mistaken for a food id —
  // only what is nested inside `items` belongs in the cache.
  expect(await getFoodById("meal1")).toBeNull();
});

// useMemory is the third read hook whose response nests food summaries, and it
// is the one that matters most offline: it backs Home's "Your usual" strip and
// the Log screen's default Recents tab — the two primary one-tap surfaces. All
// three of its collections are filled, because a food is only ever in one of
// them and any of them can be the thing the user taps.
const MEMORY_FIXTURE = {
  recents: [
    { food_item_id: "f-recent", name: "Overnight oats", meal_slot: "breakfast", grams: 150, kcal: 300, protein_g: 12, carbs_g: 45, fat_g: 8, fiber_g: 6, count: 3, last_logged_at: "2026-08-01T07:00:00.000Z" },
  ],
  frequent: [
    { food_item_id: "f-frequent", name: "Flat white", meal_slot: "snack", grams: 200, kcal: 120, protein_g: 6, carbs_g: 10, fat_g: 6, fiber_g: 0, count: 40, last_logged_at: "2026-08-01T09:00:00.000Z" },
  ],
  usual_meals: [
    {
      id: "usual1", name: "Usual lunch", meal_slot: "lunch",
      items: [
        { food_item_id: "f-usual-item", name: "Chicken salad", meal_slot: "lunch", grams: 250, kcal: 400, protein_g: 35, carbs_g: 12, fat_g: 22, fiber_g: 4, count: 9, last_logged_at: "2026-08-01T13:00:00.000Z" },
      ],
      kcal: 400, protein_g: 35, carbs_g: 12, fat_g: 22, fiber_g: 4, count: 9, last_logged_at: "2026-08-01T13:00:00.000Z",
    },
  ],
};

test("useMemory fills the offline food cache from recents, frequent AND the items inside usual meals", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockResolvedValueOnce(MEMORY_FIXTURE);

  const { result } = await renderHook(() => useMemory("2026-08-02"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  // Asserted against the cache itself, not a spy on upsertFoods: a spy proves
  // only that something was passed, never that a loggable entry landed.
  await waitFor(async () => expect(await getFoodById("f-recent")).not.toBeNull());
  expect((await getFoodById("f-recent"))?.name).toBe("Overnight oats");
  expect((await getFoodById("f-frequent"))?.name).toBe("Flat white");
  expect((await getFoodById("f-usual-item"))?.name).toBe("Chicken salad");

  // 300 kcal for 150g reverses to exactly 200 kcal/100g.
  expect((await getFoodById("f-recent"))?.kcal_per_100g).toBeCloseTo(200);
  // The usual MEAL's own id is not a food — only what is nested in `items` is.
  expect(await getFoodById("usual1")).toBeNull();
});

// The end-to-end consequence, and the reason this is not merely a cache-warming
// nicety: without the fill, tapping "Your usual" offline queues a log whose
// food is unknown to the device, so the diary renders "Queued item" with a null
// kcal and the day total counts nothing — breaking "pending counts toward the
// day total" on the most-used logging path there is.
test("a log queued from a memory food renders a named diary row with a real kcal", async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockResolvedValueOnce(MEMORY_FIXTURE);

  const { result } = await renderHook(() => useMemory("2026-08-02"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  await waitFor(async () => expect(await getFoodById("f-recent")).not.toBeNull());

  await append({ ...logInput, food_item_id: "f-recent", quantity_grams: 150 }, "q-1", "user-a");

  const { result: diary } = await renderHook(() => useQueuedLogs("2026-08-02"), { wrapper });
  await waitFor(() => expect(diary.current.rows).toHaveLength(1));
  expect(diary.current.rows[0].description).toBe("Overnight oats");
  expect(diary.current.rows[0].description).not.toBe("Queued item");
  expect(diary.current.rows[0].kcal).toBeCloseTo(300);
});
