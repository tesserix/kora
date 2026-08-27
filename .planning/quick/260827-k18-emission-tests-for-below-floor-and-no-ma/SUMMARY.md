---
status: complete
---

# Emission tests for `below_floor` and `no_match`

## What changed

Two tests in `api/internal/ai/outcome_test.go`, plus a `seedNonsenseFood`
helper. No production code changed.

- `TestNoMatchIsRecordedWhenNothingResolvesAndNothingDecomposes`
- `TestBelowFloorIsRecordedWhenEveryCandidateMissesTheFloor`

`TestResolveTextRecordsEachBranch` gained a note saying it is not, despite the
name, every branch — that docstring is what made the gap easy to miss.

## Why it was missing

Mislabelling BOTH inbox-feeding kinds as `outcomeResolved` previously left the
full suite's failure set byte-identical to baseline. That mutation would
permanently empty the `/admin/inbox` triage queue and inflate the first-try
rate while every test stayed green.

## The finding that shaped the test

**`below_floor` is unreachable through the full-text path.** `quality()` is
`0.4*Coverage + 0.3*Precision + 0.3*Trigram`, and Coverage is always 1.0 within
the full-text candidate set because `plainto_tsquery` ANDs every term — so any
row full-text recalls already scores at least 0.4, the floor itself. The branch
is only reachable via the embedding path, where `quality()` takes
`embeddingFactor*EmbSim` and Coverage can be zero.

`repository.go` already notes that local and CI databases have zero embedded
rows, which is why the branch had never been exercised outside production. The
test seeds one embedded row, making the score exact arithmetic
(`0.85 * 0.4 = 0.34`) and — as the only embedded row — immune to the dev/prod
index divergence that this package's other data-dependent tests trip over.

Two premise checks failed honestly along the way before that: a two-word guess
recalled nothing at all (`plainto_tsquery` ANDs — kora#184's own bug), and a
single-token guess then scored 0.525 via the Coverage floor.

## Tests

Mutation-verified one kind at a time, checking exit codes:

- `below_floor` → `resolved`: exit 1, killed by
  `TestBelowFloorIsRecorded...` alone, on its kind assertion.
- post-decompose `no_match` → `resolved`: exit 1, killed by
  `TestNoMatchIsRecorded...` alone, on its kind assertion.
- Both together, full suite: now fails; previously byte-identical to baseline.

`internal/ai` green 3/3 consecutive runs. Seeded rows and embeddings return to
zero afterwards.

## Note for the next session

`internal/nutrition` and `internal/fasting` have flaky/data-dependent local
failures that vary run to run (`TestCuratedParmaAliasResolves`,
`TestStartHandlesGenuineConcurrentStarts` and others). CI is green on `main`,
so these are local-environment artifacts, not a red tree — but it makes
"the suite is green locally" an unusable signal. Compare failure SETS against a
baseline rather than reading the exit code alone.

Only text-mode emission is covered. `ResolvePhoto` reaches the FIRST `no_match`
site (its `decomposeSubject` can return empty); text cannot. That site is still
unpinned.
