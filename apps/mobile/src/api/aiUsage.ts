import type { AIQuotaWindow, AIUsageStatus } from "./types";

export function aiQuotaWindows(status: AIUsageStatus): AIQuotaWindow[] {
  return [status.daily, status.weekly, status.monthly];
}

export function remainingAIRequests(status: AIUsageStatus): number {
  return Math.min(...aiQuotaWindows(status).map((window) => window.remaining));
}

export function availableAgainAt(status: AIUsageStatus): string | null {
  const exhausted = aiQuotaWindows(status).filter((window) => window.remaining === 0);
  if (exhausted.length === 0) return null;
  return exhausted.reduce((latest, window) =>
    new Date(window.resets_at).getTime() > new Date(latest).getTime() ? window.resets_at : latest,
  exhausted[0].resets_at);
}
