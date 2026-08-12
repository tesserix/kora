export type HealthStatus = "authorized" | "denied" | "unavailable";

export type HealthData = {
  status: HealthStatus;
  steps: { today: number; goal: number } | null;
  sleep: { lastNightHours: number } | null;
  connect: () => void; // re-request auth, or deep-link to Settings if denied
  // Re-read HealthKit now. The hook already refetches on foreground and on focus;
  // this is the manual path (pull-to-refresh), and resolves when the read settles
  // so a RefreshControl can hold its spinner for the real duration.
  refresh: () => Promise<void>;
};
