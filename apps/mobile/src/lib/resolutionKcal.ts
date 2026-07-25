import type { Resolution } from "@/api/types";

// The Detected total, verbatim from the server's per-candidate kcal — the only
// sanctioned client math is summing the provided kcal (never a nutrition recompute).
export function kcalTotalLabel(resolution: Resolution): string {
  if (resolution.is_estimate) {
    return `${Math.round(resolution.kcal_low ?? 0)}–${Math.round(resolution.kcal_high ?? 0)} kcal`;
  }
  const sum = resolution.candidates.reduce((total, candidate) => total + candidate.kcal, 0);
  return `${Math.round(sum)} kcal`;
}
