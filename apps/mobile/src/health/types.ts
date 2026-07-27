export type HealthStatus = "authorized" | "denied" | "unavailable";

export type HealthData = {
  status: HealthStatus;
  steps: { today: number; goal: number } | null;
  sleep: { lastNightHours: number } | null;
  connect: () => void; // re-request auth, or deep-link to Settings if denied
};
