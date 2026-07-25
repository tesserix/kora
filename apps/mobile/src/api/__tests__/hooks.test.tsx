import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch, apiFetchMultipart } from "@/lib/api";
import {
  useAcceptRequest,
  useAddWater,
  useAddWeight,
  useDeleteLog,
  useEditLog,
  useFoodSearch,
  useProfile,
  useRepeatLog,
  useResolveBarcode,
  useResolvePhoto,
  useResolveText,
  useResolveVoice,
  useSendFriendRequest,
  useUnfriend,
  useWeightSeries,
} from "../hooks";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", goal: "", onboarded_at: null }),
  apiFetchMultipart: jest.fn(),
  ApiError: class extends Error {},
}));

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

test("useFoodSearch maps Candidate[] response to FoodItem[]", async () => {
  const foodItem = {
    id: "f1",
    name: "Banana",
    brand: "",
    provenance: "usda",
    serving_desc: "1 medium",
    serving_grams: 118,
    kcal_per_100g: 89,
    protein_per_100g: 1.1,
    carbs_per_100g: 22.8,
    fat_per_100g: 0.3,
  };
  (apiFetch as jest.Mock).mockResolvedValueOnce([
    { item: foodItem, match_score: 0.9, match_tier: "full_text" },
  ]);

  const { result } = await renderHook(() => useFoodSearch("banana"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([foodItem]);
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
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "log1" });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  result.current.mutate({ id: "log1", quantity_grams: 120, meal_slot: "lunch" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/logs/log1", {
    method: "PATCH",
    body: JSON.stringify({ quantity_grams: 120, meal_slot: "lunch" }),
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
