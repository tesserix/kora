import { baseQuantityFor, defaultServingCount, formatPortion } from "../portion";

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
