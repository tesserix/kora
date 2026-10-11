import {
  compositionValuesFromReading,
  draftFromValues,
  parseCompositionDraft,
  parseReadingDate,
  previewValues,
} from "../bodyCompositionForm";

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

describe("parseReadingDate — kora#314's date row", () => {
  it("accepts a well-formed date on or before today", () => {
    expect(parseReadingDate("2026-08-19", "2026-08-22")).toEqual({ ok: true, value: "2026-08-19" });
    expect(parseReadingDate("2026-08-22", "2026-08-22")).toEqual({ ok: true, value: "2026-08-22" });
  });

  it("rejects a date after today — a screenshot cannot show tomorrow", () => {
    const result = parseReadingDate("2026-08-23", "2026-08-22");
    expect(result).toEqual({ ok: false, error: "Date can't be in the future." });
  });

  it("rejects a well-formed date that does not exist", () => {
    // The shape regex accepts all of these; none of them are real days. Go's
    // time.Parse rejects them server-side, so without this the user types a
    // date the form accepts and then gets a generic save failure.
    for (const nonexistent of ["2026-02-31", "2026-13-45", "2026-00-00", "2025-02-29"]) {
      expect(parseReadingDate(nonexistent, "2026-08-22")).toEqual({
        ok: false,
        error: "That date doesn't exist. Enter it as YYYY-MM-DD.",
      });
    }
  });

  it("still accepts a real leap day", () => {
    expect(parseReadingDate("2024-02-29", "2026-08-22")).toEqual({ ok: true, value: "2024-02-29" });
  });

  it("rejects anything that isn't YYYY-MM-DD", () => {
    expect(parseReadingDate("22/08/2026", "2026-08-22").ok).toBe(false);
    expect(parseReadingDate("2026-8-9", "2026-08-22").ok).toBe(false);
    expect(parseReadingDate("", "2026-08-22").ok).toBe(false);
    expect(parseReadingDate("not a date", "2026-08-22").ok).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(parseReadingDate("  2026-08-19  ", "2026-08-22")).toEqual({ ok: true, value: "2026-08-19" });
  });
});

describe("compositionValuesFromReading — kora#314's initialValues seed", () => {
  it("carries every numeric field the reader saw", () => {
    const values = compositionValuesFromReading({
      weight_kg: 70.2,
      body_fat_pct: 24.2,
      reading_date: "2026-08-19",
    });
    expect(values).toEqual({ weight_kg: 70.2, body_fat_pct: 24.2 });
  });

  it("omits reading_date — it is not a composition metric", () => {
    const values = compositionValuesFromReading({ weight_kg: 70.2, reading_date: "2026-08-19" });
    expect("reading_date" in values).toBe(false);
  });

  it("omits every field the reader could not see, rather than defaulting to 0", () => {
    const values = compositionValuesFromReading({ weight_kg: 70.2 });
    expect(Object.keys(values)).toEqual(["weight_kg"]);
    expect("body_fat_pct" in values).toBe(false);
    expect("bone_mass_kg" in values).toBe(false);
  });

  it("keeps a legitimately read 0 as a measured 0", () => {
    const values = compositionValuesFromReading({ weight_kg: 70.2, body_fat_pct: 0 });
    expect(values.body_fat_pct).toBe(0);
    expect("body_fat_pct" in values).toBe(true);
  });
});

describe("previewValues — what the live derived readout reads", () => {
  it("omits a field that is blank or still being typed, rather than reading it as 0", () => {
    const values = previewValues({ weight_kg: "70.2", body_fat_pct: "", muscle_mass_kg: "abc" }, "metric");
    expect(values).toEqual({ weight_kg: 70.2 });
  });

  it("omits an out-of-range value instead of deriving from it", () => {
    expect(previewValues({ weight_kg: "70.2", body_fat_pct: "132" }, "metric")).toEqual({ weight_kg: 70.2 });
  });

  it("converts an imperial entry so the derivation runs in kg", () => {
    expect(previewValues({ weight_kg: "150" }, "imperial").weight_kg).toBeCloseTo(68.0388555, 4);
  });
});

// kora#45's tape measurements. The values here are deliberately synthetic
// repeating-digit figures, not anyone's measurements — this repo is public.
describe("tape measurements", () => {
  it("omits every untouched tape field, exactly as it does the scale metrics", () => {
    const payload = ok(parseCompositionDraft({ weight_kg: "70.2" }, "manual", "metric"));
    for (const key of ["neck_cm", "chest_cm", "waist_cm", "hip_cm", "arm_cm", "thigh_cm"]) {
      expect(key in payload).toBe(false);
    }
    // Belt and braces against a `?? 0` anywhere on the path: a request body
    // carrying `"waist_cm":0` would be stored as a measured 0cm waist.
    expect(JSON.stringify(payload)).not.toContain("_cm");
  });

  it("carries only the tape fields that were filled in", () => {
    const payload = ok(
      parseCompositionDraft({ weight_kg: "70.2", waist_cm: "88.8", arm_cm: "22.2" }, "manual", "metric"),
    );
    expect(payload).toEqual({ weight_kg: 70.2, waist_cm: 88.8, arm_cm: 22.2, source: "manual" });
  });

  it("reads an imperial entry as INCHES and sends centimetres", () => {
    // The column is centimetres whatever the user's preference. 35 in is
    // 88.9 cm; storing the typed 35 would be a different body.
    const payload = ok(parseCompositionDraft({ weight_kg: "154", waist_cm: "35" }, "manual", "imperial"));
    expect(payload.waist_cm).toBeCloseTo(88.9, 6);
  });

  it("rejects a 0, which is an empty field that arrived as a number rather than a measurement", () => {
    expect(bad(parseCompositionDraft({ weight_kg: "70", waist_cm: "0" }, "manual", "metric")).waist_cm).toBe(
      "Waist must be between 0 and 300 cm.",
    );
  });

  it("rejects a value past 300cm, catching millimetres typed into a centimetre field", () => {
    const errors = bad(parseCompositionDraft({ weight_kg: "70", hip_cm: "999" }, "manual", "metric"));
    expect(errors.hip_cm).toBe("Hip must be between 0 and 300 cm.");
    // 300 exactly is the server's inclusive maximum, so the form must take it.
    expect(ok(parseCompositionDraft({ weight_kg: "70", hip_cm: "300" }, "manual", "metric")).hip_cm).toBe(300);
  });

  it("states the bound in the unit the field is SHOWING, not in stored centimetres", () => {
    // "between 0 and 300 in" would be 762cm — a limit this very form then
    // refuses, telling the user a number it will not accept.
    const errors = bad(parseCompositionDraft({ weight_kg: "154", waist_cm: "999" }, "manual", "imperial"));
    expect(errors.waist_cm).toBe("Waist must be between 0 and 118.1 in.");
    expect(errors.waist_cm).not.toContain("300");
  });

  it("round-trips a stored centimetre value back into an imperial field as inches", () => {
    expect(draftFromValues({ waist_cm: 88.9 }, "imperial").waist_cm).toBe("35.0");
    expect(draftFromValues({ waist_cm: 88.9 }, "metric").waist_cm).toBe("88.9");
  });

  it("keeps an unreadable or out-of-range tape value out of the live preview", () => {
    // Lenient where parseCompositionDraft is strict — mid-keystroke these are
    // simply not values yet, so they contribute nothing rather than a zero.
    expect(previewValues({ weight_kg: "70", waist_cm: "88.8.8" }, "metric")).toEqual({ weight_kg: 70 });
    expect(previewValues({ weight_kg: "70", thigh_cm: "999" }, "metric")).toEqual({ weight_kg: 70 });
    expect(previewValues({ weight_kg: "70", thigh_cm: "44.4" }, "metric")).toEqual({
      weight_kg: 70,
      thigh_cm: 44.4,
    });
  });
});
