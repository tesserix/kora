import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSavedMeals } from "../hooks";

const mockApiFetch = jest.fn();
// The reminder scheduler now consults the signed-in user before it (re-)arms
// anything (#171), which pulls @/lib/firebase into this module graph — and
// firebase ships ESM that Jest cannot transform. A signed-in stub keeps the
// import hermetic and preserves the pre-#171 behaviour of these tests, where
// the reconcile pass ran unconditionally.
jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { authStateReady: async () => {}, currentUser: { uid: "test-user" } },
}));

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
