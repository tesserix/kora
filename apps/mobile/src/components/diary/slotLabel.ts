export interface SlotLabel {
  label: string;
  detail: string;
}

// Pure formatting for a meal-slot ZoneRule (spec 2026-08-16 "Diary
// recomposition"): the slot name is the engraved `label`, the kcal subtotal
// is a separate `detail` so ZoneRule can render it in mono/tabular-nums
// instead of merging it into one sans-engraved string. ZoneRule uppercases
// both, so this stays lowercase and lets that be the single place casing
// happens.
export function formatSlotLabel(slot: string, kcal: number): SlotLabel {
  return { label: slot, detail: `· ${kcal} kcal` };
}
