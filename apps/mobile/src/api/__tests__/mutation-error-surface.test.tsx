import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useLeaveGroup } from "@/api/hooks";
import { apiFetch } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchEnvelope: jest.fn(),
  currentUserId: jest.fn(async () => "u1"),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// #83 asserts that a failed tap leaves an isPending-gated control "permanently
// disabled until the screen is remounted". That claim decides how big the fix
// is: if the control really is dead, adding an onError toast is not enough and
// the gating pattern itself has to change.
//
// This pins the actual behaviour of the REAL hook against a REAL QueryClient,
// rather than the screen tests' mocked `@/api/hooks`, which cannot see it.
test("a failed mutation clears isPending, so an isPending-gated control re-enables", async () => {
  (apiFetch as jest.Mock).mockRejectedValue(
    Object.assign(new Error("boom"), { name: "NetworkError" }),
  );

  // renderHook MUST be awaited here (RNTL 14 + React 19) — the same trap as
  // fireEvent elsewhere in this repo. Unawaited, `result` is undefined.
  const { result } = await renderHook(() => useLeaveGroup(), { wrapper });

  expect(result.current.isPending).toBe(false);

  result.current.mutate({ groupId: "g1", userId: "u1" });

  await waitFor(() => expect(result.current.isError).toBe(true));

  // The control's `disabled={m.isPending}` therefore goes back to false.
  expect(result.current.isPending).toBe(false);
});
