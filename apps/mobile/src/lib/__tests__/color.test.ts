import { hslToHex, withAlpha } from "../color";

describe("hslToHex", () => {
  test("pure red", () => {
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
  });

  test("pure green", () => {
    expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
  });

  test("pure blue", () => {
    expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
  });

  test("desaturated mid-lightness gray", () => {
    expect(hslToHex(200, 0, 0.5)).toBe("#808080");
  });

  test("black at zero lightness regardless of hue", () => {
    expect(hslToHex(90, 1, 0)).toBe("#000000");
  });
});

describe("withAlpha", () => {
  test("converts a hex color to an rgba string with the given alpha", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  });
});
