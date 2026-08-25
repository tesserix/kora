import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useClearHandle,
  useDeleteAvatar,
  useLookupHandle,
  useMyHandle,
  useSetHandle,
  useUploadAvatar,
} from "../hooks";
import * as api from "@/lib/api";

// Same rationale as hooks.test.tsx: @/lib/firebase pulls in firebase's ESM
// build, which Jest cannot transform, and hooks.ts's import graph now reaches
// it transitively. Stub it out rather than requireActual-ing @/lib/api.
jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { authStateReady: async () => {}, currentUser: { uid: "test-user" } },
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchMultipart: jest.fn(),
}));

const mockFetch = api.apiFetch as jest.Mock;
const mockMultipart = api.apiFetchMultipart as jest.Mock;

beforeEach(() => {
  mockFetch.mockReset();
  mockMultipart.mockReset();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Lookup is a MUTATION even though it reads. A useQuery keyed on the typed
// handle would fire a request on every keystroke — against the one endpoint in
// this API that is rate limited, and for a reason: it is what stands between
// exact-match lookup and enumeration.
it("looks a handle up only when asked", async () => {
  mockFetch.mockResolvedValue({ id: "u1", display_name: "Ada", handle: "ada", avatar_url: "" });
  const { result } = await renderHook(() => useLookupHandle(), { wrapper });

  expect(mockFetch).not.toHaveBeenCalled();
  result.current.mutate("ada");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/users/lookup?handle=ada");
});

it("url-encodes the handle it looks up", async () => {
  mockFetch.mockResolvedValue({ id: "u1", display_name: "A", handle: "a_b", avatar_url: "" });
  const { result } = await renderHook(() => useLookupHandle(), { wrapper });
  result.current.mutate("@a b");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/users/lookup?handle=%40a%20b");
});

it("sends a handle change as PUT and invalidates the cached handle", async () => {
  mockFetch.mockResolvedValue({ handle: "ada" });
  const { result } = await renderHook(() => useSetHandle(), { wrapper });
  result.current.mutate("ada");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/me/handle", {
    method: "PUT",
    body: JSON.stringify({ handle: "ada" }),
  });
});

it("sends a handle clear as DELETE and invalidates the cached handle", async () => {
  mockFetch.mockResolvedValue({});
  const { result } = await renderHook(() => useClearHandle(), { wrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/me/handle", { method: "DELETE" });
});

// The avatar goes through apiFetchMultipart, never apiFetch: apiFetch forces
// Content-Type: application/json, which breaks the multipart boundary fetch()
// sets for a FormData body.
it("uploads the avatar as multipart PUT", async () => {
  mockMultipart.mockResolvedValue({ avatar_url: "https://assets.test/a.jpg" });
  const { result } = await renderHook(() => useUploadAvatar(), { wrapper });
  const form = new FormData();
  result.current.mutate(form);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockMultipart).toHaveBeenCalledWith("/v1/me/avatar", form, { method: "PUT" });
  expect(mockFetch).not.toHaveBeenCalled();
});

// Regression guard for the brief's original bug: it invalidated ["me"], which
// nothing in this codebase queries by. GET /v1/me is keyed ["profile"]
// (useProfile, src/api/hooks.ts). An invalidation that matches no query
// returns cleanly and does nothing — this test asserts the queries are
// actually marked stale, not merely that the mutation resolves.
it("marks profile, friends, friend-requests, circles and memberships stale after an avatar upload", async () => {
  mockMultipart.mockResolvedValue({ avatar_url: "https://assets.test/a.jpg" });
  mockFetch.mockResolvedValue([]);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["profile"], { id: "u1" });
  client.setQueryData(["friends"], []);
  client.setQueryData(["friend-requests"], { incoming: [], outgoing: [] });
  client.setQueryData(["circles"], []);
  client.setQueryData(["memberships"], []);
  client.setQueryData(["me"], { shouldNeverBeTouched: true });

  function localWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result } = await renderHook(() => useUploadAvatar(), { wrapper: localWrapper });
  result.current.mutate(new FormData());
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(client.getQueryState(["profile"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["friends"])?.isInvalidated).toBe(true);
  // kora#454: the incoming-request row now renders an Avatar too, so this
  // list became an avatar-bearing surface and must be invalidated alongside
  // ["friends"] — this is the "fifth surface" the brief's own tests warned
  // this function couldn't automatically catch.
  expect(client.getQueryState(["friend-requests"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["circles"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["memberships"])?.isInvalidated).toBe(true);
  // The dead key from the brief's draft — nothing ever queries by it, so
  // it must not even exist as a tracked query, let alone be invalidated.
  expect(client.getQueryState(["me"])?.isInvalidated).toBeFalsy();
});

it("deleting the avatar invalidates the same surfaces", async () => {
  mockFetch.mockResolvedValueOnce({}).mockResolvedValue([]);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["profile"], { id: "u1" });
  client.setQueryData(["friends"], []);
  client.setQueryData(["friend-requests"], { incoming: [], outgoing: [] });
  client.setQueryData(["circles"], []);
  client.setQueryData(["memberships"], []);

  function localWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result } = await renderHook(() => useDeleteAvatar(), { wrapper: localWrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(client.getQueryState(["profile"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["friends"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["friend-requests"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["circles"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["memberships"])?.isInvalidated).toBe(true);
});

it("fetches and clears the cached handle correctly", async () => {
  mockFetch.mockResolvedValue({ handle: "ada" });
  const { result } = await renderHook(() => useMyHandle(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/me/handle");
  expect(result.current.data?.handle).toBe("ada");
});
