import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useFoodSearch, useProfile } from "../hooks";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", goal: "", onboarded_at: null }),
  ApiError: class extends Error {},
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
