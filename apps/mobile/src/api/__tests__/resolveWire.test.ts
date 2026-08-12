import { normalizeResolution } from "../resolveWire";

function rawCandidate(overrides: Record<string, unknown> = {}) {
  return {
    item: { name: "Nescafé Mocha" },
    portion_grams: 100,
    kcal: 183,
    match_score: 1.0,
    match_tier: "alias",
    ...overrides,
  };
}

test("normalizeResolution keeps portion_assumed true when the wire sends it", () => {
  const result = normalizeResolution({
    candidates: [rawCandidate({ portion_assumed: true })],
    tier: "auto",
    is_estimate: false,
    provenance: "barcode",
  });

  expect(result.candidates[0].portion_assumed).toBe(true);
});

test("normalizeResolution coerces an absent portion_assumed to false", () => {
  const result = normalizeResolution({
    candidates: [rawCandidate()],
    tier: "auto",
    is_estimate: false,
    provenance: "barcode",
  });

  expect(result.candidates[0].portion_assumed).toBe(false);
});
