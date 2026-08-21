import {
  bmi,
  derivedComposition,
  fatFreeMassKg,
  fatMassKg,
  isComparable,
} from "../bodyComposition";

describe("bmi", () => {
  it("derives from profile height and weight", () => {
    expect(bmi(70.2, 165)).toBeCloseTo(25.79, 2);
  });

  it("is null without a height, rather than a placeholder number", () => {
    expect(bmi(70.2, undefined)).toBeNull();
    expect(bmi(undefined, 165)).toBeNull();
  });

  it("rejects a height that is really metres, instead of returning 28080", () => {
    expect(bmi(70.2, 1.65)).toBeNull();
  });

  it("rejects a non-positive weight", () => {
    expect(bmi(0, 165)).toBeNull();
    expect(bmi(-70, 165)).toBeNull();
  });
});

describe("fatMassKg", () => {
  it("converts the stored percentage into the other unit Omron prints", () => {
    // Omron's own screenshot shows both 32.6 % and 22.9 kg for this body.
    expect(fatMassKg(70.2, 32.6)).toBeCloseTo(22.89, 2);
  });

  it("keeps a measured 0% as 0kg rather than treating it as unknown", () => {
    expect(fatMassKg(70.2, 0)).toBe(0);
  });

  it("is null when body fat was never measured", () => {
    expect(fatMassKg(70.2, undefined)).toBeNull();
  });

  it("refuses an impossible percentage", () => {
    expect(fatMassKg(70.2, 132)).toBeNull();
    expect(fatMassKg(70.2, -1)).toBeNull();
  });
});

describe("fatFreeMassKg", () => {
  it("is weight minus fat mass", () => {
    // Omron prints 58.21 kg fat-free for a 81.11 kg / 28.2 % reading.
    expect(fatFreeMassKg(81.11, 28.2)).toBeCloseTo(58.24, 2);
  });

  it("is null when body fat is absent, because it cannot be derived", () => {
    expect(fatFreeMassKg(81.11, undefined)).toBeNull();
  });

  it("sums back to weight with fat mass", () => {
    const weight = 70.2;
    expect((fatMassKg(weight, 32.6) ?? 0) + (fatFreeMassKg(weight, 32.6) ?? 0)).toBeCloseTo(
      weight,
      10,
    );
  });
});

describe("derivedComposition", () => {
  // The case the whole schema decision rests on: a stored body_fat_pct plus
  // weight_kg yields fat mass, while BMI comes from the PROFILE height — never
  // from a stored column, because there is none and there must not be one.
  it("derives fat mass from the entry and BMI from the profile height", () => {
    const entry = { weight_kg: 70.2, body_fat_pct: 32.6 };
    const derived = derivedComposition(entry, 165);

    expect(derived.fatMassKg).toBeCloseTo(22.89, 2);
    expect(derived.fatFreeMassKg).toBeCloseTo(47.31, 2);
    expect(derived.bmi).toBeCloseTo(25.79, 2);
  });

  it("yields no BMI when the profile has no height, even with a full entry", () => {
    const derived = derivedComposition({ weight_kg: 70.2, body_fat_pct: 32.6 }, undefined);

    expect(derived.bmi).toBeNull();
    // The measured half is unaffected: only the height-dependent value is lost.
    expect(derived.fatMassKg).toBeCloseTo(22.89, 2);
  });

  it("yields only BMI when the scale measured nothing but weight", () => {
    const derived = derivedComposition({ weight_kg: 70.2 }, 165);

    expect(derived.bmi).toBeCloseTo(25.79, 2);
    expect(derived.fatMassKg).toBeNull();
    expect(derived.fatFreeMassKg).toBeNull();
  });
});

describe("isComparable", () => {
  it("joins readings from the same instrument", () => {
    expect(isComparable("manual", "manual")).toBe(true);
  });

  it("refuses to join a DEXA scan to a scale reading", () => {
    // Six months of scale readings followed by a DEXA scan would otherwise
    // draw a cliff that is entirely an artefact of the instrument.
    expect(isComparable("scale_screenshot", "dexa")).toBe(false);
    expect(isComparable("inbody", "healthkit")).toBe(false);
  });
});
