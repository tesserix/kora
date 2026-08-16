import type { FoodItem } from "@/api/types";

// Bounds on a food's own stored serving, for deciding whether it describes a
// portion a person plausibly eats in one sitting.
//
// Deliberately the same 1-500 g window the SERVER uses (see
// api/internal/ai/portion.go, plausibleServingGrams). Those bounds were chosen
// from the shipped index — 7,470 of 7,764 USDA rows carrying a serving fall
// inside it, and the rows above the ceiling are whole-animal reference masses
// ("Turkey, whole, meat and skin, raw", 5717 g) rather than servings.
//
// Keeping the two in step matters: this figure is what the row displays and
// what gets sent as quantity_grams, while the server recomputes kcal from it.
// If the client accepted a serving the server would have rejected, the card
// would show a portion the diary then disagrees with.
const MIN_PLAUSIBLE_SERVING_GRAMS = 1;
const MAX_PLAUSIBLE_SERVING_GRAMS = 500;

// The flat fallback when a food carries no usable serving of its own. Matches
// the server's defaultPortionGrams.
const DEFAULT_PORTION_GRAMS = 100;

function plausible(grams: number | null | undefined): grams is number {
  return (
    typeof grams === "number" &&
    grams >= MIN_PLAUSIBLE_SERVING_GRAMS &&
    grams <= MAX_PLAUSIBLE_SERVING_GRAMS
  );
}

/**
 * The portion a newly hand-picked food should start at, with whether that
 * figure is an assumption.
 *
 * `assumed` is NOT cosmetic — it drives the row's "portion is a guess" marker,
 * and the two must not drift apart. A food that names its own serving is not a
 * guess; the flat 100 g default is.
 *
 * Exists because a promoted row used to inherit the portion of the food it
 * replaced (kora#190). Seeding from the replacement's own serving means the
 * common case is correct without the user opening the editor at all.
 */
export function initialPortionFor(item: FoodItem): { grams: number; assumed: boolean } {
  if (plausible(item.serving_grams)) {
    return { grams: item.serving_grams, assumed: false };
  }
  return { grams: DEFAULT_PORTION_GRAMS, assumed: true };
}
