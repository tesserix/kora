import type { Resolution, ResolvedCandidate } from "@/api/types";

// A candidate is loggable unless the server called it out as needing a
// follow-up. An absent tier means an older server, and absent data is not
// evidence of doubt — treat it as loggable rather than silently dropping food.
export function isLoggable(candidate: ResolvedCandidate): boolean {
  return candidate.tier !== "follow_up";
}

export function loggableCandidates(resolution: Resolution): ResolvedCandidate[] {
  return resolution.candidates.filter(isLoggable);
}

// Loggable is not the same as countable. A row the user picked by hand will be
// logged, but carries no server-computed kcal — it contributes nothing to the
// total and renders "—", because deriving its kcal here would put nutrition
// math in the client.
export function contributesKcal(candidate: ResolvedCandidate): boolean {
  return isLoggable(candidate) && !candidate.kcal_unknown;
}
