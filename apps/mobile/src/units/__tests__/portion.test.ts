import { formatPortion } from "../portion";

describe("formatPortion", () => {
  it("shows a named serving as entered", () => {
    expect(formatPortion({ quantity_grams: 16.5, entered_amount: 1, entered_unit: "sachet" })).toBe("1 sachet");
  });

  it("pluralises a named serving above one", () => {
    expect(formatPortion({ quantity_grams: 33, entered_amount: 2, entered_unit: "sachet" })).toBe("2 sachets");
  });

  it("keeps a fractional amount readable", () => {
    expect(formatPortion({ quantity_grams: 79, entered_amount: 0.5, entered_unit: "cup" })).toBe("0.5 cup");
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

  it("falls back to the base unit for a legacy liquid log", () => {
    expect(formatPortion({ quantity_grams: 200, base_unit: "ml" })).toBe("200 ml");
  });

  it("rounds a legacy gram figure for display", () => {
    expect(formatPortion({ quantity_grams: 16.5 })).toBe("17 g");
  });
});
