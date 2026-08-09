import { contributesKcal, isLoggable, isUncertain, loggableCandidates } from "../candidateTier";
import type { Resolution, ResolvedCandidate } from "@/api/types";

function candidate(tier: ResolvedCandidate["tier"], kcal = 100): ResolvedCandidate {
  return {
    item: { id: "f1", name: "Thing" } as ResolvedCandidate["item"],
    portion_grams: 100,
    kcal,
    match_score: 0.8,
    match_tier: "full_text",
    tier,
  };
}

// `follow_up` marks a WEAK match, not an absent one: the server still ships
// the row's own item, portion_grams and kcal (see decomposeAndEstimate). The
// card preselects that top match, so the row is loggable — the tier only
// changes how it is PRESENTED (see isUncertain), never whether it can be
// logged. Excluding it here is what produced "Add 0 items to diary" on an
// all-weak capture, leaving the user with no way to log at all.
test("a follow_up item is loggable — the card preselects the server's top match", () => {
  expect(isLoggable(candidate("auto"))).toBe(true);
  expect(isLoggable(candidate("confirm"))).toBe(true);
  expect(isLoggable(candidate("follow_up"))).toBe(true);
});

// The tier still means something — it drives the row's presentation, so the
// user can see which rows are a guess they may want to change before logging.
test("only follow_up items read as uncertain", () => {
  expect(isUncertain(candidate("auto"))).toBe(false);
  expect(isUncertain(candidate("confirm"))).toBe(false);
  expect(isUncertain(candidate("follow_up"))).toBe(true);
});

// An older server sends no tier at all. Absent data is not evidence of doubt:
// the row is loggable and reads as confident, not as a guess.
test("a candidate with no tier is loggable and not uncertain", () => {
  const legacy = { ...candidate("auto") } as Partial<ResolvedCandidate>;
  delete legacy.tier;
  expect(isLoggable(legacy as ResolvedCandidate)).toBe(true);
  expect(isUncertain(legacy as ResolvedCandidate)).toBe(false);
});

test("loggableCandidates keeps the preselected uncertain rows", () => {
  const resolution = {
    candidates: [candidate("auto"), candidate("follow_up"), candidate("confirm")],
  } as Resolution;
  expect(loggableCandidates(resolution)).toHaveLength(3);
});

// A preselected uncertain row carries the server's OWN kcal for its top match,
// so it counts toward the total exactly like any other row — the client is
// still never deriving nutrition, it is echoing what the server sent.
test("a preselected uncertain row contributes its server kcal", () => {
  expect(contributesKcal(candidate("follow_up", 120))).toBe(true);
});

// A row the user resolved by hand is loggable but has no server-computed kcal.
// It must not contribute to a total, and must never render a number — showing
// "0 kcal" would be the client inventing nutrition.
test("a hand-picked row is loggable but contributes no kcal", () => {
  const picked = { ...candidate("confirm", 0), kcal_unknown: true };
  expect(isLoggable(picked)).toBe(true);
  expect(contributesKcal(picked)).toBe(false);
  expect(contributesKcal(candidate("confirm", 120))).toBe(true);
});
