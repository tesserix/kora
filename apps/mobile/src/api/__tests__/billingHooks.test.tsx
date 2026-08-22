import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useAIOrder, useAIOrders, useAIPacks, useCreateAIOrder } from "../hooks";

jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { authStateReady: async () => {}, currentUser: { uid: "user-a" } },
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  ApiError: class extends Error {},
  NetworkError: class extends Error {},
  TimeoutError: class extends Error {},
  CancelledError: class extends Error {},
  isNetworkError: () => false,
}));

const mockFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const order = { id: "order-1", pack_code: "spark", status: "created", total_paise: 6_018 };

beforeEach(() => {
  mockFetch.mockReset();
});

test("packs are unwrapped from their envelope", async () => {
  mockFetch.mockResolvedValue({ packs: [{ code: "spark" }] });
  const { wrapper } = createHarness();

  const { result } = await renderHook(() => useAIPacks(), { wrapper });

  await waitFor(() => expect(result.current.data).toEqual([{ code: "spark" }]));
  expect(mockFetch).toHaveBeenCalledWith("/v1/ai/packs");
});

test("purchase history is unwrapped from its envelope", async () => {
  mockFetch.mockResolvedValue({ orders: [order] });
  const { wrapper } = createHarness();

  const { result } = await renderHook(() => useAIOrders(), { wrapper });

  await waitFor(() => expect(result.current.data).toEqual([order]));
  expect(mockFetch).toHaveBeenCalledWith("/v1/ai/orders");
});

// The pack code and phone go to the server, which prices the order. The app
// never sends an amount: a client-supplied price is a client-supplied
// discount.
test("creating an order sends the pack and phone, never a price", async () => {
  mockFetch.mockResolvedValue(order);
  const { wrapper } = createHarness();

  const { result } = await renderHook(() => useCreateAIOrder(), { wrapper });
  await result.current.mutateAsync({ pack_code: "spark", phone: "9876543210" });

  expect(mockFetch).toHaveBeenCalledWith("/v1/ai/orders", {
    method: "POST",
    body: JSON.stringify({ pack_code: "spark", phone: "9876543210" }),
  });
});

test("no order id means no request at all", async () => {
  const { wrapper } = createHarness();

  await renderHook(() => useAIOrder(null), { wrapper });

  await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());
});

// A settled order stops the poll; the AI allowance is refreshed at the same
// moment so a paid pack is visible without a manual pull.
test("a settled order stops polling and refreshes the allowance", async () => {
  mockFetch.mockResolvedValue({ ...order, status: "paid" });
  const { client, wrapper } = createHarness();
  const invalidate = jest.spyOn(client, "invalidateQueries");

  const { result } = await renderHook(() => useAIOrder("order-1"), { wrapper });

  await waitFor(() => expect(result.current.data?.status).toBe("paid"));
  expect(mockFetch).toHaveBeenCalledWith("/v1/ai/orders/order-1");
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai-usage", "user-a"] }),
  );
});
