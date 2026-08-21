import { draftFromValues, parseCompositionDraft } from "../bodyCompositionForm";

const ok = (result: ReturnType<typeof parseCompositionDraft>) => {
  if (!result.ok) throw new Error(`expected a valid draft, got ${JSON.stringify(result.errors)}`);
  return result.payload;
};

const bad = (result: ReturnType<typeof parseCompositionDraft>) => {
  if (result.ok) throw new Error(`expected errors, got ${JSON.stringify(result.payload)}`);
  return result.errors;
};

describe("absent is not zero", () => {
  it("omits an untouched field's key entirely, so it reaches the column as NULL", () => {
    const payload = ok(parseCompositionDraft({ weight_kg: "70.2" }, "manual", "metric"));
    expect(Object.keys(payload).sort()).toEqual(["source", "weight_kg"]);
    expect("body_fat_pct" in payload).toBe(false);
    // The failure this guards is a `?? 0` anywhere on the path: a body fat of
    // 0.0% is a measurement, and a chart cannot tell it from "not measured".
    expect(JSON.stringify(payload)).not.toContain("body_fat_pct");
  });

  it("treats a blank and a whitespace-only field the same as a missing one", () => {
    const payload = ok(
      parseCompositionDraft(
        { weight_kg: "70.2", body_fat_pct: "", muscle_mass_kg: "   " },
        "manual",
        "metric",
      ),
    );
    expect("body_fat_pct" in payload).toBe(false);
    expect("muscle_mass_kg" in payload).toBe(false);
  });

  it("keeps a typed 0 as a measured 0, which is a different fact from absent", () => {
    const payload = ok(parseCompositionDraft({ weight_kg: "70.2", body_fat_pct: "0" }, "manual", "metric"));
    expect(payload.body_fat_pct).toBe(0);
    expect("body_fat_pct" in payload).toBe(true);
  });
});

describe("required and rejected values", () => {
  it("refuses a draft with no weight — the row is a weigh-in", () => {
    expect(bad(parseCompositionDraft({ body_fat_pct: "22" }, "manual", "metric")).weight_kg).toBe(
      "Enter a weight in kg.",
    );
  });

  it("refuses a non-positive weight, matching the server", () => {
    expect(bad(parseCompositionDraft({ weight_kg: "0" }, "manual", "metric")).weight_kg).toBeTruthy();
  });

  it("rejects a percentage outside 0-100 rather than clamping it", () => {
    const errors = bad(parseCompositionDraft({ weight_kg: "70", body_fat_pct: "132" }, "manual", "metric"));
    expect(errors.body_fat_pct).toBe("Body fat must be between 0 and 100 %.");
  });

  it("rejects a percentage typed into the visceral-fat rating, using Tanita's widest scale", () => {
    const errors = bad(
      parseCompositionDraft({ weight_kg: "70", visceral_fat_rating: "62" }, "manual", "metric"),
    );
    expect(errors.visceral_fat_rating).toBe("Visceral fat must be between 0 and 59.");
    // No stray "%" — this field is a rating and its message must not imply one.
    expect(errors.visceral_fat_rating).not.toContain("%");
  });

  it("rejects text that parseFloat would have half-read", () => {
    const errors = bad(parseCompositionDraft({ weight_kg: "70", protein_pct: "18abc" }, "manual", "metric"));
    expect(errors.protein_pct).toBe("Protein must be a number.");
  });

  it("reports every bad field at once, not one per save", () => {
    const errors = bad(
      parseCompositionDraft(
        { weight_kg: "70", body_fat_pct: "132", body_water_pct: "-3", bone_mass_kg: "0" },
        "manual",
        "metric",
      ),
    );
    expect(Object.keys(errors).sort()).toEqual(["body_fat_pct", "body_water_pct", "bone_mass_kg"]);
  });

  it("accepts a comma decimal, which a decimal-pad keyboard produces in some locales", () => {
    expect(ok(parseCompositionDraft({ weight_kg: "70,2" }, "manual", "metric")).weight_kg).toBe(70.2);
  });
});

describe("units", () => {
  it("converts only the kg-backed fields back to metric on save", () => {
    const payload = ok(
      parseCompositionDraft(
        { weight_kg: "150", muscle_mass_kg: "110", body_fat_pct: "22.4", scale_bmr_kcal: "1620" },
        "manual",
        "imperial",
      ),
    );
    expect(payload.weight_kg).toBeCloseTo(68.0388555, 4);
    expect(payload.muscle_mass_kg).toBeCloseTo(49.8951607, 4);
    // A percentage and a kcal figure are the same number in either system.
    expect(payload.body_fat_pct).toBe(22.4);
    expect(payload.scale_bmr_kcal).toBe(1620);
  });

  it("range-checks the STORED value, so an imperial entry is judged in kg", () => {
    // 0 lb is 0 kg either way — the point is that the check runs after conversion.
    expect(bad(parseCompositionDraft({ weight_kg: "0" }, "manual", "imperial")).weight_kg).toBeTruthy();
  });
});

describe("draftFromValues — the seed #314's confirm surface uses", () => {
  it("pre-fills only the metrics that were actually read", () => {
    const draft = draftFromValues({ weight_kg: 70.2, body_fat_pct: 24.2 }, "metric");
    expect(draft).toEqual({ weight_kg: "70.2", body_fat_pct: "24.2" });
    expect("visceral_fat_rating" in draft).toBe(false);
  });

  it("seeds a measured 0 as a visible 0, not an empty field", () => {
    expect(draftFromValues({ body_fat_pct: 0 }, "metric").body_fat_pct).toBe("0");
  });

  it("shows kg-backed values in the reader's own units", () => {
    const draft = draftFromValues({ weight_kg: 78.6, muscle_mass_kg: 50, body_fat_pct: 24.2 }, "imperial");
    expect(draft.weight_kg).toBe("173.3");
    expect(draft.muscle_mass_kg).toBe("110.2");
    expect(draft.body_fat_pct).toBe("24.2");
  });

  it("round-trips a seeded metric draft back to the values it came from", () => {
    const values = { weight_kg: 70.2, body_fat_pct: 24.2, visceral_fat_rating: 7 };
    const payload = ok(parseCompositionDraft(draftFromValues(values, "metric"), "scale_screenshot", "metric"));
    expect(payload).toEqual({ ...values, source: "scale_screenshot" });
  });
});

describe("source", () => {
  it("carries the caller's instrument rather than defaulting silently", () => {
    expect(ok(parseCompositionDraft({ weight_kg: "70" }, "dexa", "metric")).source).toBe("dexa");
    expect(ok(parseCompositionDraft({ weight_kg: "70" }, "scale_screenshot", "metric")).source).toBe(
      "scale_screenshot",
    );
  });
});
