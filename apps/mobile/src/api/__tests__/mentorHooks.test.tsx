import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch, currentUserId } from "@/lib/api";
import {
  useAcceptMentorProposal,
  useDeleteMentorHealth,
  useMentorCommitments,
  useMentorProfile,
  usePutMentorCheckIn,
  usePutMentorCommitment,
  usePutMentorProfile,
  useSyncMentorHealth,
} from "../hooks";

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

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  jest.clearAllMocks();
  (currentUserId as jest.Mock).mockReturnValue("user-a");
});

test("mentor profile and commitments use account-scoped query keys", async () => {
  const { client, wrapper } = createHarness();
  const profile = { coaching_style: "supportive", reminder_intensity: "balanced" };
  const commitments = [{ id: "c1", title: "Walk after work", status: "active" }];
  (apiFetch as jest.Mock).mockResolvedValueOnce(profile).mockResolvedValueOnce(commitments);

  const { result } = await renderHook(
    () => ({ profile: useMentorProfile(), commitments: useMentorCommitments() }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.profile.isSuccess && result.current.commitments.isSuccess).toBe(true));

  expect(apiFetch).toHaveBeenCalledWith("/v1/mentor/profile");
  expect(apiFetch).toHaveBeenCalledWith("/v1/mentor/commitments");
  expect(client.getQueryData(["mentor", "profile", "user-a"])).toEqual(profile);
  expect(client.getQueryData(["mentor", "commitments", "user-a"])).toEqual(commitments);
});

test("mentor mutations use retry-safe PUT contracts and refresh only the current owner", async () => {
  const { client, wrapper } = createHarness();
  const profile = { coaching_style: "educational", reminder_intensity: "light" };
  const commitment = {
    id: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532",
    title: "Drink water",
    status: "active",
  };
  (apiFetch as jest.Mock)
    .mockResolvedValueOnce(profile)
    .mockResolvedValueOnce(commitment)
    .mockResolvedValueOnce({ id: "check-1", action: "done" })
    .mockResolvedValueOnce({ synced: 1 })
    .mockResolvedValueOnce(undefined);

  const { result } = await renderHook(
    () => ({
      profile: usePutMentorProfile(),
      commitment: usePutMentorCommitment(),
      checkIn: usePutMentorCheckIn(),
      health: useSyncMentorHealth(),
      deleteHealth: useDeleteMentorHealth(),
    }),
    { wrapper },
  );

  await act(async () => {
    await result.current.profile.mutateAsync({
      motivation: "More energy",
      dietary_preferences: "Vegetarian",
      allergies: "",
      coaching_style: "educational",
      reminder_intensity: "light",
      quiet_start_minute: 1320,
      quiet_end_minute: 420,
      health_steps_enabled: true,
      health_sleep_enabled: false,
      health_workouts_enabled: false,
    });
  });
  expect(client.getQueryData(["mentor", "profile", "user-a"])).toEqual(profile);

  const input = {
    id: commitment.id,
    title: commitment.title,
    kind: "hydration" as const,
    cadence: "interval" as const,
    weekdays_mask: 127,
    start_minute: 480,
    interval_minutes: 120,
    end_minute: 1200,
    timezone: "Australia/Melbourne",
    starts_on: "2026-08-22",
    ends_on: null,
    status: "active" as const,
  };
  await act(async () => {
    await result.current.commitment.mutateAsync(input);
  });
  expect(apiFetch).toHaveBeenCalledWith(`/v1/mentor/commitments/${commitment.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...input, id: undefined }),
  });

  await act(async () => {
    await result.current.checkIn.mutateAsync({
      commitmentId: commitment.id,
      scheduled_for: "2026-08-23T08:00:00Z",
      local_date: "2026-08-23",
      action: "done",
      snoozed_until: null,
    });
    await result.current.health.mutateAsync({
      days: [{
        local_date: "2026-08-22",
        timezone: "Australia/Melbourne",
        steps: 7200,
        observed_at: "2026-08-22T10:00:00Z",
      }],
    });
    await result.current.deleteHealth.mutateAsync();
  });

  expect(apiFetch).toHaveBeenCalledWith(`/v1/mentor/commitments/${commitment.id}/check-ins`, {
    method: "PUT",
    body: JSON.stringify({
      scheduled_for: "2026-08-23T08:00:00Z",
      local_date: "2026-08-23",
      action: "done",
      snoozed_until: null,
    }),
  });
  expect(apiFetch).toHaveBeenCalledWith("/v1/mentor/health/days", expect.objectContaining({ method: "PUT" }));
  expect(apiFetch).toHaveBeenCalledWith("/v1/mentor/health/days", { method: "DELETE" });
});

test("mentor data never reuses another account's cache after a switch", async () => {
  const { client, wrapper } = createHarness();
  (apiFetch as jest.Mock).mockResolvedValueOnce({ motivation: "private A" });
  const { result, rerender } = await renderHook(() => useMentorProfile(), { wrapper });
  await waitFor(() => expect(result.current.data?.motivation).toBe("private A"));

  (currentUserId as jest.Mock).mockReturnValue("user-b");
  (apiFetch as jest.Mock).mockResolvedValueOnce({ motivation: "private B" });
  rerender(undefined);
  await waitFor(() => expect(result.current.data?.motivation).toBe("private B"));

  expect(client.getQueryData(["mentor", "profile", "user-a"])).toEqual({ motivation: "private A" });
  expect(client.getQueryData(["mentor", "profile", "user-b"])).toEqual({ motivation: "private B" });
});

test("accepting an AI proposal is an explicit owner-scoped PUT and refreshes the coach thread", async () => {
  const { client, wrapper } = createHarness();
  const commitment = { id: "commitment-1", title: "Walk after lunch", status: "active" };
  (apiFetch as jest.Mock).mockResolvedValue(commitment);
  client.setQueryData(["coach", "thread", "user-a"], { turns: [] });
  const { result } = await renderHook(() => useAcceptMentorProposal(), { wrapper });

  await act(async () => {
    await result.current.mutateAsync({
      proposalId: "proposal-1",
      commitmentId: "commitment-1",
      title: "Walk after lunch",
      kind: "walking",
      cadence: "fixed",
      weekdays_mask: 62,
      start_minute: 13 * 60,
      interval_minutes: null,
      end_minute: null,
      timezone: "Australia/Melbourne",
      starts_on: "2026-08-22",
      ends_on: null,
    });
  });

  expect(apiFetch).toHaveBeenCalledWith("/v1/mentor/proposals/proposal-1/accept", {
    method: "PUT",
    body: JSON.stringify({
      commitment_id: "commitment-1",
      title: "Walk after lunch",
      kind: "walking",
      cadence: "fixed",
      weekdays_mask: 62,
      start_minute: 13 * 60,
      interval_minutes: null,
      end_minute: null,
      timezone: "Australia/Melbourne",
      starts_on: "2026-08-22",
      ends_on: null,
    }),
  });
  await waitFor(() => expect(client.getQueryState(["coach", "thread", "user-a"])?.isInvalidated).toBe(true));
});
