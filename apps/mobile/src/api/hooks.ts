import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  DashboardSummary,
  FoodItem,
  FoodLog,
  OnboardingInput,
  Profile,
} from "./types";

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
    queryFn: () => apiFetch(`/v1/foods?q=${encodeURIComponent(q)}`) as Promise<FoodItem[]>,
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
    mutationFn: (volume_ml: number) =>
      apiFetch("/v1/water", { method: "POST", body: JSON.stringify({ volume_ml }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

export function useCopyDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
