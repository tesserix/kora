import type { Profile } from "@/api/types";

export type GoalDirection = Profile["goal"];

// Only the two color fields this decision actually reads. A plain `{ ink;
// danger }` shape (rather than the full InstrumentTokens) so both the light
// and dark palette literals — whose per-key string literals otherwise don't
// structurally match each other — are freely interchangeable here; callers
// still pass useTheme().instrument as-is.
export interface DeltaColorTokens {
  ink: string;
  danger: string;
}

// Accent-budget demotion (kora ignition Task 8): the weight delta used to be
// an unconditional instrument.accent — the design contract only grants
// Trends one accent (the chart's endpoint dot), so the delta figure now
// reads ink when the change moves toward the stated goal and danger when it
// moves away. A maintenance goal has no "away" direction to judge against —
// it always reads ink. Pure so it's unit-testable without mounting a screen.
export function deltaColor(delta: number, goalDirection: GoalDirection, instrument: DeltaColorTokens): string {
  if (goalDirection === "fat_loss") return delta <= 0 ? instrument.ink : instrument.danger;
  if (goalDirection === "muscle_gain") return delta >= 0 ? instrument.ink : instrument.danger;
  return instrument.ink;
}
