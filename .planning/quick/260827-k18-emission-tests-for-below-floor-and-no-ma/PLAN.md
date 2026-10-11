---
status: complete
---

# Emission tests for `below_floor` and `no_match`

## Why

Mutating `internal/ai/resolver.go` to record BOTH inbox-feeding kinds as
`outcomeResolved` leaves the full suite's failure set byte-identical to
baseline. Nothing catches it. That mutation would permanently empty the
`/admin/inbox` triage queue and inflate the first-try rate — the two numbers
kora#328 leans on — while every test stayed green.

`TestResolveTextRecordsEachBranch` is named "each branch" but exercises three
of ten (budget, error, cache), all of which avoid the database. `outcomeNoMatch`
appears only in a pure `outcomeFor` struct-builder test, never through a real
resolve.

## Tasks

1. Seed helper for a distinctive nonsense `food_items` row (`normalized_name`
   is a plain column, not generated — it must be set explicitly).
2. `no_match`: a guess whose food recalls nothing, plus a provider returning no
   ingredients, so `decomposeAndEstimate` reports `resolved=false`.
3. `below_floor`: a seeded row recalled by a shared lexeme but scoring under
   `minReturnableMatchScore` (0.40).
4. Mutation-verify each test fails when its own kind is mislabelled.

## Constraints

- `ResolvedCandidate.MatchScore` is the RAW index score, undamped by
  `Guess.Confidence` — confidence moves the tier, never the floor decision. So
  `below_floor` cannot be driven from the stub's confidence.
- `nutrition.Repository` is a concrete struct, not an interface, so candidates
  cannot be injected. Tests go through real pg_trgm ranking.
- Use nonsense tokens no real row can match, so the test is immune to the
  documented dev/prod index divergence (18,876 vs 26,120 rows).
- `ResolveText` passes the phrase itself as `decomposeSubject`, so the FIRST
  `no_match` site is unreachable for text. Only the post-decompose site is.
