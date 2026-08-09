/**
 * Food portion formatting. Deliberately separate from ./convert.ts, which owns
 * body weight and water and is driven by the user's metric/imperial
 * preference — food portions are always metric and must not read that setting.
 *
 * This module formats only. It never converts between units and never derives
 * nutrition: the server resolved the entered amount into quantity_grams once,
 * at write time, and that figure is authoritative.
 */

export type ServingUnit = {
  name: string;
  amount: number;
  base_amount: number;
};

export type PortionEntry = {
  quantity_grams: number;
  entered_amount?: number | null;
  entered_unit?: string | null;
  base_unit?: string | null;
};

// Bulk units render with a space and no pluralisation ("200 ml", "140 g");
// named servings pluralise ("2 sachets").
const BULK_UNITS = new Set(["g", "kg", "ml", "l"]);

function formatAmount(amount: number): string {
  // Whole numbers read as whole; fractions keep one decimal so "0.5 cup"
  // survives, but "1.0 cup" never appears.
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 10) / 10);
}

export function formatPortion(entry: PortionEntry): string {
  const { entered_amount, entered_unit } = entry;

  // A legacy row carries no entered pair. Show the canonical figure in the
  // food's own base unit — that is all the information there is.
  if (entered_amount == null || !entered_unit) {
    const unit = entry.base_unit === "ml" ? "ml" : "g";
    return `${formatAmount(entry.quantity_grams)} ${unit}`;
  }

  const unit = entered_unit.toLowerCase();
  if (BULK_UNITS.has(unit)) {
    return `${formatAmount(entered_amount)} ${unit}`;
  }
  // Pluralise only if amount > 1, and only if the name doesn't already end in "s"
  const plural = entered_amount > 1 && !entered_unit.endsWith("s") ? `${entered_unit}s` : entered_unit;
  return `${formatAmount(entered_amount)} ${plural}`;
}
