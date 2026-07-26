import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiFetchMultipart } from "@/lib/api";
import type { MealSlot } from "@/lib/mealSlot";
import type {
  AppNotification,
  Candidate,
  ChallengeDetail,
  ChallengeSummary,
  DashboardSummary,
  Friend,
  FriendRequests,
  FriendsProgress,
  FoodItem,
  FoodLog,
  GroupCode,
  GroupDetail,
  GroupProgress,
  GroupSummary,
  Metric,
  MyFriendCode,
  OnboardingInput,
  Profile,
  Resolution,
  WeightEntry,
} from "./types";

type ResolveFile = {
  uri: string;
  name: string;
  type: string;
};

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => apiFetch("/v1/me") as Promise<Profile>,
  });
}

export function useSubmitOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingInput) =>
      apiFetch("/v1/onboarding", { method: "POST", body: JSON.stringify(input) }) as Promise<Profile>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}

export function useFoodSearch(q: string) {
  return useQuery({
    queryKey: ["foods", q],
    queryFn: async () => {
      const candidates = (await apiFetch(`/v1/foods?q=${encodeURIComponent(q)}`)) as Candidate[];
      return candidates.map((candidate) => candidate.item);
    },
    enabled: q.trim().length >= 2,
  });
}

type CreateLogInput = {
  food_item_id: string;
  meal_slot: string;
  source: string;
  quantity_grams: number;
  logged_at: string;
  client_log_ms?: number;
};

export function useCreateLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLogInput) =>
      apiFetch("/v1/logs", { method: "POST", body: JSON.stringify(input) }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDayLogs(date: string) {
  return useQuery({
    queryKey: ["logs", date],
    queryFn: () => apiFetch(`/v1/logs?date=${date}`) as Promise<FoodLog[]>,
  });
}

export function useDashboard(date: string) {
  return useQuery({
    queryKey: ["dashboard", date],
    queryFn: () => apiFetch(`/v1/dashboard?date=${date}`) as Promise<DashboardSummary>,
  });
}

export function useAddWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ volume_ml, logged_at }: { volume_ml: number; logged_at?: string }) =>
      apiFetch("/v1/water", { method: "POST", body: JSON.stringify({ volume_ml, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

export type EditLogInput = {
  id: string;
  meal_slot?: MealSlot;
  quantity_grams?: number;
};

export function useEditLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: EditLogInput) =>
      apiFetch(`/v1/logs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDeleteLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/logs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useCopyDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }) as Promise<{ copied: number }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRepeatLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/logs/${id}/repeat`, { method: "POST" }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useResolveText() {
  return useMutation({
    mutationFn: (phrase: string) =>
      apiFetch("/v1/resolve/text", { method: "POST", body: JSON.stringify({ phrase }) }) as Promise<Resolution>,
  });
}

export function useResolveBarcode() {
  return useMutation({
    mutationFn: (barcode: string) =>
      apiFetch("/v1/resolve/barcode", { method: "POST", body: JSON.stringify({ barcode }) }) as Promise<Resolution>,
  });
}

export function useResolvePhoto() {
  return useMutation({
    mutationFn: (file: ResolveFile) => {
      const form = new FormData();
      // React Native FormData file shape:
      form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return apiFetchMultipart("/v1/resolve/photo", form) as Promise<Resolution>;
    },
  });
}

export function useAddWeight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ weight_kg, logged_at }: { weight_kg: number; logged_at?: string }) =>
      apiFetch("/v1/weight", { method: "POST", body: JSON.stringify({ weight_kg, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["weight"] }),
  });
}

const WEIGHT_RANGE_DAYS = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 } as const;
export type WeightRange = keyof typeof WEIGHT_RANGE_DAYS;

export function useWeightSeries(range: WeightRange) {
  return useQuery({
    queryKey: ["weight", range],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - WEIGHT_RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
      return apiFetch(`/v1/weight?from=${from.toISOString()}&to=${to.toISOString()}`) as Promise<WeightEntry[]>;
    },
  });
}

export function useResolveVoice() {
  return useMutation({
    mutationFn: (file: ResolveFile) => {
      const form = new FormData();
      form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return apiFetchMultipart("/v1/resolve/voice", form) as Promise<Resolution>;
    },
  });
}

export function useFriends() {
  return useQuery({
    queryKey: ["friends"],
    queryFn: () => apiFetch("/v1/friends") as Promise<Friend[]>,
  });
}

export function useFriendRequests() {
  return useQuery({
    queryKey: ["friend-requests"],
    queryFn: () => apiFetch("/v1/friends/requests") as Promise<FriendRequests>,
  });
}

export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email?: string; code?: string }) =>
      apiFetch("/v1/friends/requests", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/accept`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useDeclineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/decline`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friend-requests"] }),
  });
}

export function useUnfriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiFetch(`/v1/friends/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friends"] }),
  });
}

export function useMyFriendCode() {
  return useQuery({
    queryKey: ["friend-code"],
    queryFn: () => apiFetch("/v1/friends/code") as Promise<MyFriendCode>,
  });
}

export function useFriendsProgress() {
  return useQuery({
    queryKey: ["friends-progress"],
    queryFn: () => apiFetch("/v1/friends/progress") as Promise<FriendsProgress>,
  });
}

export function useSetShareProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (share_progress: boolean) =>
      apiFetch("/v1/me/share-progress", { method: "PATCH", body: JSON.stringify({ share_progress }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["friends-progress"] });
    },
  });
}

export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: () => apiFetch("/v1/groups") as Promise<GroupSummary[]> });
}

export function useGroup(id: string) {
  return useQuery({ queryKey: ["group", id], queryFn: () => apiFetch(`/v1/groups/${id}`) as Promise<GroupDetail>, enabled: !!id });
}

export function useGroupProgress(id: string) {
  return useQuery({ queryKey: ["group-progress", id], queryFn: () => apiFetch(`/v1/groups/${id}/progress`) as Promise<GroupProgress>, enabled: !!id });
}

export function useGroupCode(id: string) {
  return useQuery({ queryKey: ["group-code", id], queryFn: () => apiFetch(`/v1/groups/${id}/code`) as Promise<GroupCode>, enabled: !!id });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch("/v1/groups", { method: "POST", body: JSON.stringify({ name }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useJoinGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiFetch("/v1/groups/join", { method: "POST", body: JSON.stringify({ code }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useLeaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group", groupId] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => apiFetch(`/v1/groups/${groupId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useGroupChallenges(groupId: string) {
  return useQuery({
    queryKey: ["group-challenges", groupId],
    queryFn: () => apiFetch(`/v1/groups/${groupId}/challenges`) as Promise<ChallengeSummary[]>,
    enabled: !!groupId,
  });
}

export function useChallenge(cid: string) {
  return useQuery({
    queryKey: ["challenge", cid],
    queryFn: () => apiFetch(`/v1/challenges/${cid}`) as Promise<ChallengeDetail>,
    enabled: !!cid,
  });
}

export function useCreateChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, title, metric, duration }: { groupId: string; title: string; metric: Metric; duration: string }) =>
      apiFetch(`/v1/groups/${groupId}/challenges`, { method: "POST", body: JSON.stringify({ title, metric, duration }) }) as Promise<{ id: string }>,
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}

export function useJoinChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "POST" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useLeaveChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "DELETE" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useDeleteChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}

export function useNotifications() {
  return useQuery({ queryKey: ["notifications"], queryFn: () => apiFetch("/v1/notifications") as Promise<AppNotification[]> });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => apiFetch("/v1/notifications/unread-count") as Promise<{ count: number }>,
    refetchInterval: 60000,
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/notifications/read", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications", "unread"] });
    },
  });
}
