import type { Resolution, ResolvedCandidate } from "@/api/types";

// Every candidate the server emits is loggable. `follow_up` marks a WEAK
// match, not an absent one — decomposeAndEstimate prices the row (item,
// portion_grams and kcal) before estimateIngredientTier ever looks at the
// match score, so the top guess is already on the wire and the card can
// preselect it. Treating "weak" as "unusable" is what emptied the batch and
// produced a disabled "Add 0 items to diary" on an all-weak capture, leaving
// the user no way to log at all.
export function isLoggable(_candidate: ResolvedCandidate): boolean {
  return true;
}

// Presentation only, never eligibility. An uncertain row is preselected like
// any other, but stays visibly a guess the user can change before logging —
// otherwise a weak match gets written to the diary in one tap, unread. An
// absent tier means an older server, and absent data is not evidence of
// doubt, so those rows read as confident.
export function isUncertain(candidate: ResolvedCandidate): boolean {
  return candidate.tier === "follow_up";
}

export function loggableCandidates(resolution: Resolution): ResolvedCandidate[] {
  return resolution.candidates.filter(isLoggable);
}

// Loggable is not the same as countable. A row the user picked by hand will be
// logged, but carries no server-computed kcal — it contributes nothing to the
// total and renders "—", because deriving its kcal here would put nutrition
// math in the client. A preselected uncertain row is the opposite case: it
// carries the server's own kcal for its top match, so it counts verbatim.
export function contributesKcal(candidate: ResolvedCandidate): boolean {
  return !candidate.kcal_unknown;
}
