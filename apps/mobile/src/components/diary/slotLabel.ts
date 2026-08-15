// Pure formatting for a meal-slot ZoneRule (spec 2026-08-16 "Diary
// recomposition"): "breakfast · 380 kcal" — ZoneRule itself uppercases the
// whole string, so this stays lowercase and lets that be the single place
// casing happens.
export function formatSlotLabel(slot: string, kcal: number): string {
  return `${slot} · ${kcal} kcal`;
}
