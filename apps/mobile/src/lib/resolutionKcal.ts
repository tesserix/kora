import type { Resolution } from "@/api/types";
import { contributesKcal } from "@/lib/candidateTier";

// The Detected total, verbatim from the server's per-candidate kcal — the only
// sanctioned client math is summing the provided kcal (never a nutrition
// recompute). Items the card will not log are excluded, so the number always
// describes exactly what "Add to diary" is about to write.
export function kcalTotalLabel(resolution: Resolution): string {
  if (resolution.is_estimate) {
    return `${Math.round(resolution.kcal_low ?? 0)}–${Math.round(resolution.kcal_high ?? 0)} kcal`;
  }
  const sum = resolution.candidates
    .filter(contributesKcal)
    .reduce((total, candidate) => total + candidate.kcal, 0);
  return `${Math.round(sum)} kcal`;
}
