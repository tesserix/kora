import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { apiFetch } from "@/lib/api";
import Diary from "../(tabs)/diary";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

// The queue has its own tests; this file is about what happens to an ORDINARY
// mutation while the device is offline.
jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  ApiError: class extends Error {},
  NetworkError: class extends Error {},
  isNetworkError: () => true,
}));

// Deliberately NOT a fresh QueryClient with hand-written defaults. This test
// exists to prove a property of the APP's client configuration, so it reads the
// real defaults out of src/lib/queryClient — delete the mutation networkMode
// there and this test goes red, which a locally-authored default would hide.
// A separate instance, so no cache leaks between tests.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  (apiFetch as jest.Mock).mockReset();
  // The whole point: the system is in the state the feature is for. Wiring
  // connectivity into onlineManager (app/_layout.tsx) means react-query's
  // DEFAULT mutation networkMode ("online") pauses every mutation here —
  // isPending forever, onError never called, control stuck disabled.
  onlineManager.setOnline(false);
});
afterEach(() => onlineManager.setOnline(true));

test("an offline water tap reports an error instead of disabling the pills forever", async () => {
  (apiFetch as jest.Mock).mockRejectedValue(new Error("Network request failed"));

  const ui = await render(<Diary />, { wrapper });
  await fireEvent.press(ui.getByText("+250 ml"));

  // The mutation must actually RUN and reject. Paused, it never reaches the
  // network and this text never appears.
  await waitFor(() => expect(ui.getByText("Couldn't add water. Try again.")).toBeTruthy());
  expect(apiFetch).toHaveBeenCalledWith("/v1/water", expect.objectContaining({ method: "POST" }));

  // And the control must come back. `disabled={addWater.isPending}` is the
  // visible symptom of a paused mutation: one tap and both pills are dead for
  // the rest of the session, with nothing on screen saying why.
  expect(ui.getByLabelText("Add 250 ml water").props.accessibilityState).toEqual(
    expect.objectContaining({ disabled: false }),
  );
  expect(ui.getByLabelText("Add 500 ml water").props.accessibilityState).toEqual(
    expect.objectContaining({ disabled: false }),
  );
});
