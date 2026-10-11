import { trendSentence, trendUnavailableNote } from "../trendCopy";
import { COMPOSITION_METRICS } from "../bodyCompositionFields";

const weight = COMPOSITION_METRICS.find((m) => m.key === "weight_kg")!;
const waist = COMPOSITION_METRICS.find((m) => m.key === "waist_cm")!;
const ok = { status: "ok" as const, rate_per_week: -0.4, basis: { readings: 9, days: 42 }, spans_instruments: false, show_support: false };

test("states the rate in the past tense, with its basis", () => {
  expect(trendSentence(ok, weight, "metric")).toBe(
    "About 0.4 kg per week down — based on 9 readings over the last 42 days.",
  );
});

test("says up for a gain, never a bare signed number", () => {
  expect(trendSentence({ ...ok, rate_per_week: 0.25 }, weight, "metric")).toContain("0.3 kg per week up");
});

test("converts to the reader's units", () => {
  // -0.4 kg/week * 2.2046226218 lb/kg = 0.8818... -> rounds to 0.9. Asserting
  // the converted magnitude (not just the unit label) so this test actually
  // fails if the conversion is skipped, not only if the label is wrong.
  const s = trendSentence(ok, weight, "imperial");
  expect(s).toContain("0.9 lb per week down");
  expect(s).not.toContain("kg");
});

test("uses inches for a tape measurement in imperial", () => {
  // -1 cm/week / 2.54 cm/in = -0.3937... -> rounds to 0.4.
  const s = trendSentence({ ...ok, rate_per_week: -1 }, waist, "imperial");
  expect(s).toContain("0.4 in per week down");
});

test("ignores a stray rate and basis when status is not ok (defensive)", () => {
  // rate_per_week and basis are documented as absent unless status === "ok",
  // but this guards the case where the API contract is violated — a status
  // that isn't "ok" must never produce a sentence, even if a rate happens to
  // be present.
  expect(trendSentence({ ...ok, status: "insufficient_data" }, weight, "metric")).toBeNull();
});

test("renders nothing when there is not enough data", () => {
  expect(trendSentence({ ...ok, status: "insufficient_data", rate_per_week: undefined, basis: undefined }, weight, "metric")).toBeNull();
});

test("renders nothing when suppressed", () => {
  expect(trendSentence({ ...ok, status: "suppressed", rate_per_week: undefined, basis: undefined }, weight, "metric")).toBeNull();
});

// The #23 requirement, asserted as exclusions rather than trusted as a convention.
test("never promises: no future tense, no date, no goal", () => {
  for (const rate of [-0.9, -0.1, 0, 0.1, 0.9]) {
    const s = trendSentence({ ...ok, rate_per_week: rate }, weight, "metric") ?? "";
    // Non-vacuous: fails loudly if trendSentence ever regresses to null/"" for
    // an "ok" trend with a fitted rate, so the exclusion check below can never
    // pass by having nothing to check.
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/\bwill\b|\byou'?ll\b|\bexpect\b|\bby [A-Z][a-z]+\b|\bon track\b|\bgoal\b|\breach\b/i);
  }
});

test("rounds to one decimal — more digits are false precision here", () => {
  expect(trendSentence({ ...ok, rate_per_week: -0.4567 }, weight, "metric")).toContain("0.5 kg per week");
});

// kora#405: insufficient_data and suppressed both rendered as nothing, which
// is indistinguishable from a bug. The gate now explains itself; the guardrail
// deliberately does not.
describe("trendUnavailableNote (kora#405)", () => {
  const base = { spans_instruments: false, show_support: false } as const;

  test("explains the gate when there simply are not enough weigh-ins", () => {
    const note = trendUnavailableNote({ ...base, status: "insufficient_data" });
    expect(note).toContain("Not enough weigh-ins");
    expect(note).toContain("4");
    expect(note).toContain("14 days");
  });

  // THE load-bearing test. A message here would disclose to the user that the
  // Protective policy has classified them as at eating-disorder risk — the
  // inference #23 exists to act on quietly.
  test("says NOTHING when the trend was suppressed by the guardrail", () => {
    expect(trendUnavailableNote({ ...base, status: "suppressed", show_support: true })).toBeNull();
  });

  test("says nothing when there IS a rate — the sentence covers that case", () => {
    expect(
      trendUnavailableNote({
        ...base,
        status: "ok",
        rate_per_week: -0.4,
        basis: { readings: 9, days: 42 },
      }),
    ).toBeNull();
  });
});
