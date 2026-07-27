import {
  cmFromFtIn,
  mlToFlOz,
  flOzToMl,
  formatWeight,
  kgFromLb,
  lbFromKg,
  parseWeightToKg,
  weightUnitLabel,
} from "../convert";

describe("lbFromKg / kgFromLb round-trips", () => {
  test("lbFromKg converts kg to lb", () => {
    expect(lbFromKg(78.6)).toBeCloseTo(173.28, 1);
  });

  test("kgFromLb converts lb to kg", () => {
    expect(kgFromLb(150)).toBeCloseTo(68.04, 1);
  });

  test("round-trips kg -> lb -> kg", () => {
    const kg = 78.6;
    expect(kgFromLb(lbFromKg(kg))).toBeCloseTo(kg, 6);
  });
});

describe("cmFromFtIn", () => {
  test("cmFromFtIn converts feet+inches to cm", () => {
    expect(cmFromFtIn(5, 11)).toBeCloseTo(180.34, 2);
  });
});

describe("formatWeight", () => {
  test("metric formats kg to one decimal", () => {
    expect(formatWeight(78.6, "metric")).toEqual({ value: "78.6", unit: "kg" });
  });

  test("imperial formats lb to one decimal", () => {
    expect(formatWeight(78.6, "imperial")).toEqual({ value: "173.3", unit: "lb" });
  });
});

describe("weightUnitLabel", () => {
  test("returns kg for metric", () => {
    expect(weightUnitLabel("metric")).toBe("kg");
  });

  test("returns lb for imperial", () => {
    expect(weightUnitLabel("imperial")).toBe("lb");
  });
});

describe("parseWeightToKg", () => {
  test("metric passthrough", () => {
    expect(parseWeightToKg("78.6", "metric")).toBeCloseTo(78.6, 6);
  });

  test("imperial converts lb text to kg", () => {
    expect(parseWeightToKg("150", "imperial")).toBeCloseTo(68.0388555, 4);
  });

  test("returns null for zero", () => {
    expect(parseWeightToKg("0", "metric")).toBeNull();
  });

  test("returns null for negative values", () => {
    expect(parseWeightToKg("-5", "metric")).toBeNull();
  });

  test("returns null for non-numeric text", () => {
    expect(parseWeightToKg("abc", "metric")).toBeNull();
  });

  test("returns null for non-numeric text in imperial mode", () => {
    expect(parseWeightToKg("abc", "imperial")).toBeNull();
  });
});

describe("volume conversion", () => {
  test("mlToFlOz converts 1000 ml to ~33.8 fl oz", () => {
    expect(mlToFlOz(1000)).toBeCloseTo(33.814, 2);
  });

  test("flOzToMl rounds a cup (8 fl oz) to 237 ml", () => {
    expect(Math.round(flOzToMl(8))).toBe(237);
  });

  test("flOzToMl rounds 16 fl oz to 473 ml", () => {
    expect(Math.round(flOzToMl(16))).toBe(473);
  });

  test("mlToFlOz / flOzToMl round-trip", () => {
    expect(flOzToMl(mlToFlOz(500))).toBeCloseTo(500, 6);
  });
});
