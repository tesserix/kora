import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch, apiFetchMultipart } from "@/lib/api";
import {
  useFoodSearch,
  useProfile,
  useResolveBarcode,
  useResolvePhoto,
  useResolveText,
  useResolveVoice,
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
