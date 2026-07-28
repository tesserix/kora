import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSavedMeals } from "../hooks";

const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useSavedMeals fetches /v1/saved-meals", async () => {
  mockApiFetch.mockResolvedValueOnce([
    { id: "m1", name: "Bfast", meal_slot: "breakfast", items: [], kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  ]);
  const { result } = await renderHook(() => useSavedMeals(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/saved-meals");
  expect(result.current.data?.[0].name).toBe("Bfast");
});
