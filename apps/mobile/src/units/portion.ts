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

// How close a computed count has to be to a whole number to count as one.
// serving_grams / base_amount is exact arithmetic on figures the row already
// carries, but 49.5 / 16.5 is 2.9999999999999996 in binary floating point.
const COUNT_EPSILON = 1e-9;

/**
 * How many of a food's own named serving make up its default portion.
 *
 * The server's units.Parse deliberately normalises a multi-count label so the
 * unit describes ONE of the thing: "2 biscuits (30g)" yields
 * {biscuit, amount 1, base_amount 15}, while the food row's serving_grams
 * keeps the FULL label serving of 30. Seeding a portion field from the unit's
 * own `amount` therefore opens on half a portion.
 *
 * This recovers the label's count. It is a QUANTITY the food row already
 * carries — no nutrition is derived. A count that is not a clean positive
 * integer is not a count a stepper can honestly show, so it falls back to one
 * serving rather than seeding a fractional or zero portion.
 */
export function defaultServingCount(servingGrams: number, serving: ServingUnit): number {
  if (!(servingGrams > 0) || !(serving.base_amount > 0)) return 1;
  const count = servingGrams / serving.base_amount;
  const rounded = Math.round(count);
  return rounded > 0 && Math.abs(count - rounded) < COUNT_EPSILON ? rounded : 1;
}

/**
 * The base-unit quantity an (amount, unit) entry describes, using only the
 * conversion the food row itself supplies. Returns null when `unit` is not one
 * of the row's named servings — there is nothing to convert with, and guessing
 * is exactly what this module refuses to do.
 *
 * Display only. The SERVER still resolves the authoritative quantity_grams
 * from the entered pair, once, at write time; this exists so a macro preview
 * cannot describe a different portion from the one that will actually be
 * logged.
 */
export function baseQuantityFor(amount: number, unit: string, servingUnits: ServingUnit[]): number | null {
  const serving = servingUnits.find((s) => s.name === unit);
  if (!serving || !(serving.amount > 0)) return null;
  return (serving.base_amount / serving.amount) * amount;
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
