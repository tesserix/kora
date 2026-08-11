import { baseQuantityFor, defaultServingCount, formatPortion, portionEntryFor, servingEntryFor } from "../portion";

describe("defaultServingCount", () => {
  it("recovers a multi-count label's own count", () => {
    // Weet-Bix: "2 biscuits (30g)" parses to one 15 g biscuit, serving_grams 30.
    expect(defaultServingCount(30, { name: "biscuit", amount: 1, base_amount: 15 })).toBe(2);
  });

  it("is one for a single-count label", () => {
    expect(defaultServingCount(16.5, { name: "sachet", amount: 1, base_amount: 16.5 })).toBe(1);
  });

  it("survives binary floating point on an exact multiple", () => {
    expect(defaultServingCount(49.5, { name: "sachet", amount: 1, base_amount: 16.5 })).toBe(3);
  });

  it("falls back to one serving rather than seeding a fraction", () => {
    expect(defaultServingCount(40, { name: "biscuit", amount: 1, base_amount: 15 })).toBe(1);
  });

  it("falls back to one serving rather than seeding zero", () => {
    expect(defaultServingCount(0, { name: "biscuit", amount: 1, base_amount: 15 })).toBe(1);
    expect(defaultServingCount(30, { name: "biscuit", amount: 1, base_amount: 0 })).toBe(1);
  });
});

describe("baseQuantityFor", () => {
  const units = [{ name: "biscuit", amount: 1, base_amount: 15 }];

  it("converts a serving count using the row's own base amount", () => {
    expect(baseQuantityFor(2, "biscuit", units)).toBe(30);
  });

  it("refuses to guess for a unit the row does not carry", () => {
    expect(baseQuantityFor(2, "cup", units)).toBeNull();
    expect(baseQuantityFor(2, "biscuit", [{ name: "biscuit", amount: 0, base_amount: 15 }])).toBeNull();
  });
});

describe("formatPortion", () => {
  it("shows a named serving as entered", () => {
    expect(formatPortion({ quantity_grams: 16.5, entered_amount: 1, entered_unit: "sachet" })).toBe("1 sachet");
  });

  it("pluralises a named serving above one", () => {
    expect(formatPortion({ quantity_grams: 33, entered_amount: 2, entered_unit: "sachet" })).toBe("2 sachets");
  });

  it("does not double-pluralise an already-plural serving name", () => {
    expect(formatPortion({ quantity_grams: 80, entered_amount: 2, entered_unit: "slices" })).toBe("2 slices");
  });

  it("keeps a fractional amount readable", () => {
    expect(formatPortion({ quantity_grams: 79, entered_amount: 0.5, entered_unit: "cup" })).toBe("0.5 cup");
  });

  it("renders fractional amounts above one correctly", () => {
    expect(formatPortion({ quantity_grams: 135, entered_amount: 1.5, entered_unit: "sachet" })).toBe("1.5 sachets");
    expect(formatPortion({ quantity_grams: 197, entered_amount: 2.5, entered_unit: "cup" })).toBe("2.5 cups");
  });

  it("shows a volume in ml for a liquid row", () => {
    expect(formatPortion({ quantity_grams: 200, entered_amount: 200, entered_unit: "ml", base_unit: "ml" })).toBe("200 ml");
  });

  it("shows grams for a mass row entered in grams", () => {
    expect(formatPortion({ quantity_grams: 140, entered_amount: 140, entered_unit: "g" })).toBe("140 g");
  });

  it("falls back to grams for a legacy log with no entered unit", () => {
    expect(formatPortion({ quantity_grams: 140 })).toBe("140 g");
  });

  it("renders fractional legacy gram values with one decimal preserved", () => {
    expect(formatPortion({ quantity_grams: 16.5 })).toBe("16.5 g");
  });

  it("renders whole legacy gram values without a trailing decimal", () => {
    expect(formatPortion({ quantity_grams: 140 })).toBe("140 g");
  });

  it("falls back to the base unit for a legacy liquid log", () => {
    expect(formatPortion({ quantity_grams: 200, base_unit: "ml" })).toBe("200 ml");
  });

  it("falls back to legacy path when amount is present but unit is null", () => {
    expect(formatPortion({ quantity_grams: 140, entered_amount: 140, entered_unit: null })).toBe("140 g");
  });

  it("falls back to legacy path when unit is present but amount is null", () => {
    expect(formatPortion({ quantity_grams: 140, entered_amount: null, entered_unit: "g" })).toBe("140 g");
  });
});

describe("servingEntryFor", () => {
  const portion = { name: "portion", amount: 1, base_amount: 16.5 };
  const biscuit = { name: "biscuit", amount: 1, base_amount: 15 };

  it("names a portion that is exactly one serving", () => {
    expect(servingEntryFor(16.5, [portion])).toEqual({ amount: 1, unit: "portion" });
  });

  it("names a portion that is an exact multiple of a serving", () => {
    expect(servingEntryFor(30, [biscuit])).toEqual({ amount: 2, unit: "biscuit" });
  });

  // The substitution must be a pure relabelling. Sending (count, unit) makes
  // the SERVER recompute quantity_grams from the serving mass, so anything but
  // an exact multiple would log a different amount than the AI resolved and
  // than the card displayed.
  it("declines a portion that is not an exact multiple", () => {
    expect(servingEntryFor(20, [portion])).toBeNull();
  });

  it("declines when the food has no named servings", () => {
    expect(servingEntryFor(16.5, [])).toBeNull();
  });

  it("declines a zero or negative portion", () => {
    expect(servingEntryFor(0, [portion])).toBeNull();
    expect(servingEntryFor(-16.5, [portion])).toBeNull();
  });

  it("ignores a serving with a non-positive base amount", () => {
    expect(servingEntryFor(16.5, [{ name: "broken", amount: 1, base_amount: 0 }])).toBeNull();
  });

  it("prefers the first serving that divides exactly", () => {
    expect(servingEntryFor(30, [portion, biscuit])).toEqual({ amount: 2, unit: "biscuit" });
  });

  // 49.5 / 16.5 is 2.9999999999999996 in binary floating point — the same
  // trap COUNT_EPSILON exists for in defaultServingCount.
  it("survives binary floating point on an exact multiple", () => {
    expect(servingEntryFor(49.5, [portion])).toEqual({ amount: 3, unit: "portion" });
  });
});

describe("portionEntryFor", () => {
  const portion = { name: "portion", amount: 1, base_amount: 16.5 };

  it("carries the named serving when one describes the quantity exactly", () => {
    expect(portionEntryFor(16.5, "g", [portion])).toEqual({
      quantity_grams: 16.5,
      base_unit: "g",
      entered_amount: 1,
      entered_unit: "portion",
    });
  });

  it("formats as the named serving", () => {
    expect(formatPortion(portionEntryFor(16.5, "g", [portion]))).toBe("1 portion");
  });

  it("omits the entered pair when no serving fits, so formatting falls back to the base unit", () => {
    const entry = portionEntryFor(20, "g", [portion]);
    expect(entry.entered_amount).toBeUndefined();
    expect(entry.entered_unit).toBeUndefined();
    expect(formatPortion(entry)).toBe("20 g");
  });

  it("keeps a millilitre food in millilitres when no serving fits", () => {
    expect(formatPortion(portionEntryFor(300, "ml", []))).toBe("300 ml");
  });

  it("tolerates a food with no serving_units at all", () => {
    expect(formatPortion(portionEntryFor(140, "g", undefined))).toBe("140 g");
  });
});

// Size descriptors are adjectives — "2 large", never "2 larges" (live bug
// caught on-device 2026-08-12). Noun units still pluralize, with -es where
// English demands it.
describe("formatPortion pluralization", () => {
  const entry = (amount: number, unit: string) => ({
    quantity_grams: 100,
    base_unit: "g",
    entered_amount: amount,
    entered_unit: unit,
  });
  const { formatPortion } = require("../portion");

  test("size descriptors never pluralize", () => {
    expect(formatPortion(entry(2, "large"))).toBe("2 large");
    expect(formatPortion(entry(3, "medium"))).toBe("3 medium");
  });

  test("noun units pluralize, with -es for sibilant endings", () => {
    expect(formatPortion(entry(2, "slice"))).toBe("2 slices");
    expect(formatPortion(entry(2, "bunch"))).toBe("2 bunches");
    expect(formatPortion(entry(1, "slice"))).toBe("1 slice");
  });
});
