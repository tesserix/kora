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
  const priced = resolution.candidates.filter(contributesKcal);
  // Candidates exist but none of them carries a server-computed kcal — every
  // row was resolved by hand, or the whole resolution came from the offline
  // cache. Summing nothing yields 0, and "0 kcal" is not "we don't know": it is
  // a number the user can read off the card and believe. The rows themselves
  // already render "—" in this state; the total must agree with them.
  if (priced.length === 0 && resolution.candidates.length > 0) return "—";
  const sum = priced.reduce((total, candidate) => total + candidate.kcal, 0);
  return `${Math.round(sum)} kcal`;
}
