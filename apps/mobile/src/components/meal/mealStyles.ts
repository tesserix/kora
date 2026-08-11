import type { InstrumentTokens } from "@/theme";

// Engraved caption treatment (spec: 10px uppercase, ls 1.4, mut) — the one
// non-accent engraved zone the meal-detail screen (app/meal.tsx) reuses
// across its provenance chip, hero caption, macro-row labels, portion/meal
// captions and header slot·time caption.
export function engravedStyle(instrument: InstrumentTokens, color: string = instrument.mut) {
  return {
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    fontWeight: "600" as const,
    color,
  };
}
