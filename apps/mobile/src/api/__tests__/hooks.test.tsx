import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProfile } from "../hooks";

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
