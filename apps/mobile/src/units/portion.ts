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

/**
 * The named serving that exactly describes a base-unit quantity, or null when
 * no serving does.
 *
 * This is what lets an AI-resolved capture say "1 portion" instead of
 * "16.5 g". The resolve endpoint returns a portion in the food's base unit and
 * the food's own `serving_units` alongside it, so the pair can be recovered
 * on the client — no new server field, and no nutrition derived here.
 *
 * EXACT multiples only, and that restriction is the whole safety argument.
 * Logging an (amount, unit) pair makes the SERVER re-resolve quantity_grams
 * from the serving's mass (foodlog.resolveEnteredUnit). If the count were
 * rounded, the amount written would differ from the one the engine resolved
 * and the one the card showed the user. Requiring exactness makes the
 * substitution a pure relabelling of an identical quantity — never a
 * different portion.
 *
 * The first serving that divides exactly wins, matching the precedence
 * everywhere else that `serving_units[0]` is treated as a food's default.
 */
export function servingEntryFor(
  baseQuantity: number,
  servingUnits: ServingUnit[],
): { amount: number; unit: string } | null {
  if (!(baseQuantity > 0)) return null;
  for (const serving of servingUnits) {
    if (!(serving.base_amount > 0)) continue;
    const count = baseQuantity / serving.base_amount;
    const rounded = Math.round(count);
    if (rounded > 0 && Math.abs(count - rounded) < COUNT_EPSILON) {
      return { amount: rounded, unit: serving.name };
    }
  }
  return null;
}

/**
 * The PortionEntry describing a resolved base-unit quantity, naming it as one
 * of the food's own servings where one fits exactly.
 *
 * The single place the AI capture path turns a resolved portion into something
 * both displayable and loggable, so the card, the re-ask sheet and the log
 * request cannot disagree about what the portion is. Where no serving fits,
 * the entered pair is simply absent and every caller falls back to the base
 * unit — the same shape a legacy row has.
 */
export function portionEntryFor(
  baseQuantity: number,
  baseUnit: string | null | undefined,
  servingUnits: ServingUnit[] | undefined,
): PortionEntry {
  const entry: PortionEntry = { quantity_grams: baseQuantity, base_unit: baseUnit ?? null };
  const serving = servingEntryFor(baseQuantity, servingUnits ?? []);
  if (!serving) return entry;
  return { ...entry, entered_amount: serving.amount, entered_unit: serving.unit };
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
  return `${formatAmount(entered_amount)} ${pluralizeUnit(entered_unit, entered_amount)}`;
}

// Size descriptors read as adjectives, not nouns — "2 large", never "2 larges".
const UNPLURALIZABLE_UNITS = new Set(["large", "medium", "small", "extra large", "extra-large", "jumbo", "mini", "regular"]);

export function pluralizeUnit(unit: string, amount: number): string {
  if (amount <= 1 || unit.endsWith("s")) return unit;
  if (UNPLURALIZABLE_UNITS.has(unit.toLowerCase())) return unit;
  // bunch → bunches, dish → dishes, box → boxes
  if (/(ch|sh|x|z)$/i.test(unit)) return `${unit}es`;
  return `${unit}s`;
}
