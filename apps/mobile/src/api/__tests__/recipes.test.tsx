import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useCreateRecipe,
  useDeleteRecipe,
  useLogRecipe,
  useParseRecipe,
  useRecipe,
  useRecipes,
  useUpdateRecipe,
} from "../hooks";

const mockApiFetch = jest.fn();
const mockApiFetchMultipart = jest.fn();
class MockApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
jest.mock("@/lib/api", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
  apiFetchMultipart: (...a: unknown[]) => mockApiFetchMultipart(...a),
  ApiError: MockApiError,
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const recipe = {
  id: "r1",
  name: "Dal",
  servings: 2,
  source: "manual" as const,
  ingredients: [],
  unresolved_count: 0,
  total_kcal: 400,
  total_protein_g: 20,
  total_carbs_g: 40,
  total_fat_g: 10,
  total_fiber_g: 5,
  per_serving_kcal: 200,
  per_serving_protein_g: 10,
  per_serving_carbs_g: 20,
  per_serving_fat_g: 5,
  per_serving_fiber_g: 2.5,
};

afterEach(() => {
  jest.clearAllMocks();
});

test("useRecipes fetches /v1/recipes", async () => {
  mockApiFetch.mockResolvedValueOnce([recipe]);
  const { result } = await renderHook(() => useRecipes(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes");
  expect(result.current.data?.[0].name).toBe("Dal");
});

test("useRecipe fetches /v1/recipes/:id", async () => {
  mockApiFetch.mockResolvedValueOnce(recipe);
  const { result } = await renderHook(() => useRecipe("r1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes/r1");
});

test("useCreateRecipe POSTs /v1/recipes and invalidates the recipes query", async () => {
  mockApiFetch.mockResolvedValueOnce(recipe);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = jest.spyOn(client, "invalidateQueries");
  const localWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const body = { name: "Dal", servings: 2, source: "manual" as const, ingredients: [] };
  const { result } = await renderHook(() => useCreateRecipe(), { wrapper: localWrapper });
  result.current.mutate(body);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes", { method: "POST", body: JSON.stringify(body) });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["recipes"] });
});

test("useUpdateRecipe PUTs /v1/recipes/:id", async () => {
  mockApiFetch.mockResolvedValueOnce(recipe);
  const body = { name: "Dal v2", servings: 3, source: "manual" as const, ingredients: [] };
  const { result } = await renderHook(() => useUpdateRecipe(), { wrapper });
  result.current.mutate({ id: "r1", body });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes/r1", { method: "PUT", body: JSON.stringify(body) });
});

test("useDeleteRecipe DELETEs /v1/recipes/:id", async () => {
  mockApiFetch.mockResolvedValueOnce({ deleted: true });
  const { result } = await renderHook(() => useDeleteRecipe(), { wrapper });
  result.current.mutate("r1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes/r1", { method: "DELETE" });
});

test("useParseRecipe POSTs text to /v1/recipes/parse", async () => {
  const draft = { name: "Dal", servings: 2, source: "paste" as const, ingredients: [] };
  mockApiFetch.mockResolvedValueOnce(draft);
  const { result } = await renderHook(() => useParseRecipe(), { wrapper });
  result.current.mutate({ text: "2 cups dal, 1 onion" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes/parse", {
    method: "POST",
    body: JSON.stringify({ text: "2 cups dal, 1 onion" }),
  });
  expect(result.current.data).toEqual(draft);
});

test("useParseRecipe POSTs a photo to /v1/recipes/parse via multipart", async () => {
  const draft = { name: "Dal", servings: 2, source: "photo" as const, ingredients: [] };
  mockApiFetchMultipart.mockResolvedValueOnce(draft);
  const form = new FormData();
  const { result } = await renderHook(() => useParseRecipe(), { wrapper });
  result.current.mutate({ photo: form });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetchMultipart).toHaveBeenCalledWith("/v1/recipes/parse", form);
  expect(mockApiFetch).not.toHaveBeenCalled();
});

test("useParseRecipe surfaces a 502 parse_failed as a distinguishable ApiError", async () => {
  mockApiFetch.mockRejectedValueOnce(new MockApiError(502, "parse_failed", "could not parse recipe"));
  const { result } = await renderHook(() => useParseRecipe(), { wrapper });
  result.current.mutate({ text: "garbled input" });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBeInstanceOf(MockApiError);
  expect((result.current.error as MockApiError).code).toBe("parse_failed");
});

test("useLogRecipe POSTs /v1/recipes/:id/log and invalidates the logs + dashboard queries", async () => {
  mockApiFetch.mockResolvedValueOnce({ logged: 2, skipped: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = jest.spyOn(client, "invalidateQueries");
  const localWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const body = { servings: 1, meal_slot: "lunch", logged_at: "2026-08-13T12:00:00Z" };
  const { result } = await renderHook(() => useLogRecipe(), { wrapper: localWrapper });
  result.current.mutate({ id: "r1", body });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/recipes/r1/log", { method: "POST", body: JSON.stringify(body) });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
});
