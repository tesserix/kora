import { contributesKcal, isLoggable, loggableCandidates } from "../candidateTier";
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

test("only follow_up items are excluded from logging", () => {
  expect(isLoggable(candidate("auto"))).toBe(true);
  expect(isLoggable(candidate("confirm"))).toBe(true);
  expect(isLoggable(candidate("follow_up"))).toBe(false);
});

// An older server sends no tier at all. Treat that as loggable: silently
// dropping food is worse than showing it, and this is the pre-upgrade shape.
test("a candidate with no tier stays loggable", () => {
  const legacy = { ...candidate("auto") } as Partial<ResolvedCandidate>;
  delete legacy.tier;
  expect(isLoggable(legacy as ResolvedCandidate)).toBe(true);
});

test("loggableCandidates drops the uncertain ones", () => {
  const resolution = {
    candidates: [candidate("auto"), candidate("follow_up"), candidate("confirm")],
  } as Resolution;
  expect(loggableCandidates(resolution)).toHaveLength(2);
});

// A row the user resolved by hand is loggable but has no server-computed kcal.
// It must not contribute to a total, and must never render a number — showing
// "0 kcal" would be the client inventing nutrition.
test("a hand-picked row is loggable but contributes no kcal", () => {
  const picked = { ...candidate("confirm", 0), kcal_unknown: true };
  expect(isLoggable(picked)).toBe(true);
  expect(contributesKcal(picked)).toBe(false);
  expect(contributesKcal(candidate("confirm", 120))).toBe(true);
  expect(contributesKcal(candidate("follow_up", 120))).toBe(false);
});
