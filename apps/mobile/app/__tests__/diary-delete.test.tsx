import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { apiFetch } from "@/lib/api";
import Diary from "../(tabs)/diary";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
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

const LOG = {
  id: "l1", description: "Oats", meal_slot: "breakfast", source: "manual",
  quantity_grams: 60, kcal: 200, protein_g: 5, carbs_g: 30, fat_g: 3,
  provenance: "afcd", logged_at: "2026-08-02T08:00:00.000Z",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Pulls the confirm-Alert's destructive handler out of the spy. The Alert is
// native, so pressing "Delete" for real is not possible here — but the handler
// it invokes is the entire delete path.
function pressDestructive(alert: jest.SpyInstance) {
  const buttons = alert.mock.calls.at(-1)?.[2] as { style?: string; onPress?: () => void }[];
  buttons.find((b) => b.style === "destructive")!.onPress!();
}

beforeEach(() => {
  (apiFetch as jest.Mock).mockReset();
  (apiFetch as jest.Mock).mockImplementation((url: string, opts?: { method?: string }) => {
    if (opts?.method === "DELETE") return Promise.reject(new Error("Network request failed"));
    if (url.startsWith("/v1/dashboard")) {
      return Promise.resolve({ consumed: { kcal: 200 }, targets: { kcal: 2000 }, water_ml: 0 });
    }
    if (url.startsWith("/v1/logs")) return Promise.resolve([LOG]);
    return Promise.resolve(null);
  });
});

// The diary's swipe-delete was the only delete in the app with no error
// surface — app/meal.tsx's identical confirm-then-delete flow has one. It fails
// by leaving the row exactly where it was, which is indistinguishable from
// nothing having happened.
test("a diary delete that fails tells the user instead of leaving the row silently in place", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  const ui = await render(<Diary />, { wrapper });
  await waitFor(() => expect(ui.getByLabelText("Delete Oats")).toBeTruthy());

  await fireEvent.press(ui.getByLabelText("Delete Oats"));
  expect(alert).toHaveBeenCalledWith("Delete this entry?", expect.any(String), expect.any(Array));

  await act(async () => { pressDestructive(alert); });

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith("Couldn't delete", "Please try again."),
  );
  // The row is still there, which is what the message now accounts for.
  expect(ui.getByLabelText("Oats")).toBeTruthy();
});
