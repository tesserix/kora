# Food-Match Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `match_score` a real similarity measure so Kora's confidence tiers stop always returning `confirm`.

**Architecture:** Recall is untouched — the `@@ plainto_tsquery` filter and the pgvector query stay exactly as they are. Postgres gains one job (`similarity()` per candidate via `pg_trgm`); all scoring logic moves into a pure, DB-free Go file so it can be unit-tested. `nutrition.Resolve` then merges candidates from all three tiers into one comparable score, sorts by it, and applies an ambiguity penalty.

**Tech Stack:** Go 1.26, GORM, PostgreSQL 15 + pgvector + pg_trgm, testify, golang-migrate.

**Spec:** `docs/superpowers/specs/2026-08-02-food-match-scoring-design.md`

## Global Constraints

- Weights are **fixed by principle and never tuned**: `0.4` coverage, `0.3` precision, `0.3` trigram, `0.85` embedding factor, `0.6`/`2.0` ambiguity. Only `tierAutoFloor` / `tierConfirmFloor` are calibrated.
- **No wire-format change, no client change.** `Candidate`, `ResolvedCandidate`, and `Resolution` keep their current JSON shape.
- **No recall change.** Do not alter the `@@ plainto_tsquery` predicate or the pgvector query's `WHERE`/`ORDER BY`/`LIMIT`.
- Commit messages: conventional prefix, **single line, no body, no trailers**.
- Run all tests in the **foreground**. Backgrounded test runs stall.
- Postgres for the Go suite: `TEST_DATABASE_URL`, default `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`. Local container `kora-pg-test` listens on **55432**, so use `postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable`.
- The Go suite requires a **clean `food_items`**. Never ingest the full index into the suite's database — Task 4 uses a separate one.

### Deviation from the spec, already decided

The spec calls for a GIN trigram index on `normalized_name`. **Do not add it.** `EXPLAIN` confirms recall is served by the existing `idx_food_items_normalized_name_fts`; `similarity()` runs only as a SELECT-list computation over the ≤25 rows that filter already returned, so a trigram index would never be used. Adding it is write amplification on 7,856 rows for no read benefit. The extension itself is still required.

---

### Task 1: Enable pg_trgm

**Files:**
- Create: `api/internal/database/migrations/000021_trigram_scoring.up.sql`
- Create: `api/internal/database/migrations/000021_trigram_scoring.down.sql`
- Test: `api/internal/nutrition/migration_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: the SQL function `similarity(text, text) → real`, available to every later task.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/nutrition/migration_test.go`:

```go
func TestTrigramExtensionAvailable(t *testing.T) {
	db := testDB(t)
	var sim float64
	err := db.Raw(`SELECT similarity('chicken breast', 'chicken breast')`).Scan(&sim).Error
	require.NoError(t, err)
	require.InDelta(t, 1.0, sim, 0.001)

	// The discriminating property: a longer, noisier name must score lower
	// than an exact one. This is precisely what ts_rank could not do.
	var exact, noisy float64
	require.NoError(t, db.Raw(`SELECT similarity('chicken breast', 'chicken breast')`).Scan(&exact).Error)
	require.NoError(t, db.Raw(`SELECT similarity('fast food fried chicken breast wing thigh drumstick nugget', 'chicken breast')`).Scan(&noisy).Error)
	require.Greater(t, exact, noisy)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -run TestTrigramExtensionAvailable -v`

Expected: FAIL with `function similarity(unknown, unknown) does not exist`.

(If it passes, the extension was created manually during design exploration. Run `docker exec kora-pg-test psql -U kora -d kora -c "DROP EXTENSION pg_trgm;"` and re-run so you observe a real RED.)

- [ ] **Step 3: Write the migration**

`api/internal/database/migrations/000021_trigram_scoring.up.sql`:

```sql
-- pg_trgm supplies similarity(), the character-level signal that replaces
-- ts_rank as the match score. ts_rank with the default normalization flag
-- ignores document length and plainto_tsquery ANDs every term, so its value
-- depends only on the number of query terms — it is constant across all
-- candidates for a given query and cannot rank them. See
-- docs/superpowers/specs/2026-08-02-food-match-scoring-design.md
--
-- No trigram index: recall is served by idx_food_items_normalized_name_fts and
-- similarity() is only computed over the rows that filter already returned, so
-- a GIN trgm index would never be used.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

`api/internal/database/migrations/000021_trigram_scoring.down.sql`:

```sql
-- Guarded: another object may depend on pg_trgm by the time this rolls back.
DROP EXTENSION IF EXISTS pg_trgm;
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go run ./cmd/migrate up`

Then: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -run TestTrigramExtensionAvailable -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/database/migrations/000021_trigram_scoring.up.sql api/internal/database/migrations/000021_trigram_scoring.down.sql api/internal/nutrition/migration_test.go
git commit -m "feat(api): enable pg_trgm for food match scoring"
```

---

### Task 2: The scoring function

Pure Go, no database. This is where every scoring decision lives.

**Files:**
- Create: `api/internal/nutrition/score.go`
- Test: `api/internal/nutrition/score_test.go`

**Interfaces:**
- Consumes: `Normalize(string) string` from `normalize.go`.
- Produces, all package-private, used by Task 3:
  - `type components struct { Coverage, Precision, Trigram, EmbSim float64 }`
  - `func tokenOverlap(query, doc string) (coverage, precision float64)`
  - `func lexical(c components) float64`
  - `func quality(c components) float64`
  - `func ambiguityFactor(margin float64) float64`

- [ ] **Step 1: Write the failing test**

Create `api/internal/nutrition/score_test.go`:

```go
package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTokenOverlap(t *testing.T) {
	tests := []struct {
		name                string
		query, doc          string
		wantCov, wantPrec   float64
	}{
		{"exact", "chicken breast", "chicken breast", 1.0, 1.0},
		{"doc has extra terms", "chicken breast", "fast food fried chicken breast", 1.0, 0.4},
		{"query has extra terms", "grilled chicken breast", "chicken breast", 2.0 / 3.0, 1.0},
		{"no shared terms", "paneer", "chicken breast", 0, 0},
		{"empty query", "", "chicken breast", 0, 0},
		{"empty doc", "chicken breast", "", 0, 0},
		{"duplicate terms counted once", "chicken chicken", "chicken", 1.0, 1.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cov, prec := tokenOverlap(tt.query, tt.doc)
			require.InDelta(t, tt.wantCov, cov, 0.001, "coverage")
			require.InDelta(t, tt.wantPrec, prec, 0.001, "precision")
		})
	}
}

func TestLexicalRanksTheRealFailureCase(t *testing.T) {
	// The exact prod case: ts_rank gave all of these 0.09910. Whatever else
	// changes, the ordering below must hold.
	exact := lexical(components{Coverage: 1, Precision: 1, Trigram: 1.000})
	roasted := lexical(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.682})
	grilled := lexical(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.652})
	friedShort := lexical(components{Coverage: 1, Precision: 0.400, Trigram: 0.556})
	friedLong := lexical(components{Coverage: 1, Precision: 0.222, Trigram: 0.278})

	require.Greater(t, exact, roasted)
	require.Greater(t, roasted, grilled)
	require.Greater(t, grilled, friedShort)
	require.Greater(t, friedShort, friedLong)
	require.InDelta(t, 1.0, exact, 0.001)
}

func TestQualityEmbeddingIsABoosterNeverAPenalty(t *testing.T) {
	// The load-bearing property: a row with no embedding must score exactly
	// its lexical value. 302 of 7,856 prod rows are embedded, so if a missing
	// embedding could lower a score, coverage gaps would distort every
	// comparison.
	c := components{Coverage: 1, Precision: 0.5, Trigram: 0.6, EmbSim: 0}
	require.InDelta(t, lexical(c), quality(c), 0.0001)

	// A strong semantic match lifts a weak lexical one.
	weak := components{Coverage: 0, Precision: 0, Trigram: 0.1, EmbSim: 0.9}
	require.InDelta(t, 0.85*0.9, quality(weak), 0.0001)

	// ...but never drags a strong lexical match down.
	strong := components{Coverage: 1, Precision: 1, Trigram: 1, EmbSim: 0.1}
	require.InDelta(t, 1.0, quality(strong), 0.0001)
}

func TestQualityStaysInUnitInterval(t *testing.T) {
	max := quality(components{Coverage: 1, Precision: 1, Trigram: 1, EmbSim: 1})
	require.LessOrEqual(t, max, 1.0)
	min := quality(components{})
	require.GreaterOrEqual(t, min, 0.0)
}

func TestAmbiguityFactor(t *testing.T) {
	require.InDelta(t, 0.6, ambiguityFactor(0), 0.001)      // dead tie
	require.InDelta(t, 0.618, ambiguityFactor(0.009), 0.001) // the prod near-tie
	require.InDelta(t, 1.0, ambiguityFactor(0.2), 0.001)    // clearly separated
	require.InDelta(t, 1.0, ambiguityFactor(5), 0.001)      // clamped above
	require.InDelta(t, 0.6, ambiguityFactor(-1), 0.001)     // clamped below
}

func TestScoringSeparatesTheAmbiguousFromTheClear(t *testing.T) {
	// This is the whole point of the change, expressed as one test.
	exact := quality(components{Coverage: 1, Precision: 1, Trigram: 1.000})
	roasted := quality(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.682})
	grilled := quality(components{Coverage: 1, Precision: 2.0 / 3.0, Trigram: 0.652})

	// Index contains an exact row → confident.
	clear := exact * ambiguityFactor(exact-roasted)
	require.Greater(t, clear, 0.90, "an exact match with a clear runner-up must reach auto")

	// Prod index has no exact row, just near-identical variants → uncertain.
	ambiguous := roasted * ambiguityFactor(roasted-grilled)
	require.Less(t, ambiguous, 0.70, "near-tied candidates must fall to follow_up")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/nutrition/ -run 'TestTokenOverlap|TestLexical|TestQuality|TestAmbiguity|TestScoring' -v`

Expected: FAIL to compile — `undefined: tokenOverlap`, `undefined: components`, etc.

- [ ] **Step 3: Write the implementation**

Create `api/internal/nutrition/score.go`:

```go
package nutrition

import "strings"

// Scoring weights, fixed by principle and deliberately NOT tuned against the
// golden set. Seven free parameters fitted to a set of that size would be
// overfitting dressed as rigour; only the tier floors in ai/types.go are
// calibrated against measured data.
const (
	weightCoverage  = 0.4
	weightPrecision = 0.3
	weightTrigram   = 0.3

	// embeddingFactor keeps an embedding-only match below an exact alias (1.0)
	// while still letting it outscore a weak lexical match.
	embeddingFactor = 0.85

	// ambiguityFloor is the multiplier applied when the top two candidates are
	// indistinguishable; ambiguitySlope is how fast confidence recovers as they
	// separate. A margin of 0.20 or more counts as unambiguous.
	ambiguityFloor = 0.6
	ambiguitySlope = 2.0
)

// components are the raw per-candidate signals feeding quality().
type components struct {
	Coverage  float64 // |Q∩D| / |Q| — how much of the query this row accounts for
	Precision float64 // |Q∩D| / |D| — how much of this row the query explains
	Trigram   float64 // pg_trgm similarity(normalized_name, query)
	EmbSim    float64 // cosine similarity; 0 when the row has no embedding
}

// tokenOverlap returns coverage and precision for two already-Normalize()d
// phrases, comparing them as token *sets* so a repeated word cannot inflate
// either side. Both are 0 when either phrase has no tokens.
func tokenOverlap(query, doc string) (coverage, precision float64) {
	qSet := fieldSet(query)
	dSet := fieldSet(doc)
	if len(qSet) == 0 || len(dSet) == 0 {
		return 0, 0
	}
	shared := 0
	for w := range qSet {
		if dSet[w] {
			shared++
		}
	}
	return float64(shared) / float64(len(qSet)), float64(shared) / float64(len(dSet))
}

func fieldSet(s string) map[string]bool {
	fields := strings.Fields(s)
	set := make(map[string]bool, len(fields))
	for _, w := range fields {
		set[w] = true
	}
	return set
}

// lexical combines the three lexical signals into 0..1.
//
// Coverage is always 1.0 *within* the full-text candidate set, because
// plainto_tsquery ANDs every term. It is not dead weight: it is what separates
// full-text candidates from embedding-only ones, which share few or no query
// terms. That is the mechanism making a sub-0.70 score reachable at all.
func lexical(c components) float64 {
	return weightCoverage*c.Coverage + weightPrecision*c.Precision + weightTrigram*c.Trigram
}

// quality is per-candidate match strength. The embedding term is a booster and
// never a penalty: a row with no embedding has EmbSim 0 and scores exactly its
// lexical value, so the index's partial embedding coverage cannot distort a
// comparison between rows.
func quality(c components) float64 {
	l := lexical(c)
	if e := embeddingFactor * c.EmbSim; e > l {
		return e
	}
	return l
}

// ambiguityFactor scales confidence by how clearly the best candidate beats the
// runner-up. A perfect top match surrounded by near-identical alternatives is
// not a confident answer — it is a question.
func ambiguityFactor(margin float64) float64 {
	f := ambiguityFloor + ambiguitySlope*margin
	if f < ambiguityFloor {
		return ambiguityFloor
	}
	if f > 1 {
		return 1
	}
	return f
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/nutrition/ -run 'TestTokenOverlap|TestLexical|TestQuality|TestAmbiguity|TestScoring' -v`

Expected: PASS, all subtests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition/score.go api/internal/nutrition/score_test.go
git commit -m "feat(api): add a discriminating food match scoring function"
```

---

### Task 3: Wire the score into Resolve

**Files:**
- Modify: `api/internal/nutrition/repository.go:97-221` (`Resolve`)
- Test: `api/internal/nutrition/resolve_test.go`

**Interfaces:**
- Consumes: `components`, `tokenOverlap`, `quality`, `ambiguityFactor` from Task 2; `similarity()` from Task 1.
- Produces: `Resolve` with an unchanged signature, now returning candidates sorted by a discriminating `MatchScore`, with `MatchTier` naming the signal that actually won.

**Three behaviour changes, all deliberate:**
1. The `0.7 + 0.29*s` clamp is deleted. It structurally guaranteed `≥ confirm`.
2. Candidates from all tiers merge into one pool, are scored comparably, and are sorted by score — so `out[:limit]` stops discarding embedding candidates and `cands[0]` stops being an arbitrary pick among ties.
3. `MatchTier` becomes informative: `embedding` when the embedding term produced the score, otherwise `full_text`.

**Alias rows are exempt from ambiguity scaling** and keep exactly `1.0`. An exact user alias is exact intent. Without the exemption, an alias tying with an equally-scored full-text row would be dragged to `0.6` and land in `follow_up`.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/nutrition/resolve_test.go`:

```go
// TestResolveBreaksTiesThatTsRankCannot is the regression guard for the bug
// this whole change exists to fix. Every one of these rows has an IDENTICAL
// ts_rank (0.09910 for a two-term query); if match_score is ever again a
// function of ts_rank alone, these assertions fail.
func TestResolveBreaksTiesThatTsRankCannot(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	names := []string{
		"Chicken breast",
		"Chicken breast roasted",
		"Grilled chicken breast",
		"Fast foods fried chicken breast",
		"Fast foods fried chicken breast wing thigh drumstick nugget",
	}
	items := make([]FoodItem, 0, len(names))
	for _, n := range names {
		items = append(items, FoodItem{Name: n, Provenance: ProvenanceUSDA, KcalPer100g: 165})
	}
	_, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "chicken breast", nil, 10)
	require.NoError(t, err)
	require.Len(t, cands, 5)

	// The exact row wins, not an arbitrary tied one.
	require.Equal(t, "Chicken breast", cands[0].Item.Name)

	// Scores are strictly descending — i.e. they actually discriminate.
	for i := 1; i < len(cands); i++ {
		require.Less(t, cands[i].MatchScore, cands[i-1].MatchScore,
			"candidate %d (%q) must score below %d (%q)",
			i, cands[i].Item.Name, i-1, cands[i-1].Item.Name)
	}

	// The specific prod failure: the clinical near-duplicate must lose.
	require.Greater(t, cands[0].MatchScore, cands[len(cands)-1].MatchScore)
	require.Contains(t, cands[len(cands)-1].Item.Name, "wing thigh drumstick")
}

// TestResolveScoreIsNotFloored proves the 0.7 clamp is gone. Under the old
// formula every full-text candidate was structurally >= 0.70 and follow_up was
// unreachable.
func TestResolveScoreIsNotFloored(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	// Two near-identical variants and no exact row — the real prod shape for
	// "chicken breast".
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Chicken breast roasted", Provenance: ProvenanceUSDA, KcalPer100g: 165},
		{Name: "Grilled chicken breast", Provenance: ProvenanceUSDA, KcalPer100g: 165},
	})
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "chicken breast", nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Less(t, cands[0].MatchScore, 0.70,
		"near-tied candidates must be able to score below the confirm floor")
}

// TestResolveAliasKeepsExactScore guards the exemption: an alias is exact
// intent and must not be dragged down by an equally-scored full-text row.
func TestResolveAliasKeepsExactScore(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Brekkie eggs", Provenance: ProvenanceCurated, KcalPer100g: 150},
		{Name: "Brekkie eggs deluxe", Provenance: ProvenanceCurated, KcalPer100g: 150},
	})
	require.NoError(t, err)

	var target FoodItem
	require.NoError(t, tx.First(&target, "name = ?", "Brekkie eggs").Error)
	require.NoError(t, tx.Exec(
		`INSERT INTO food_aliases (user_id, alias, food_item_id) VALUES (NULL, ?, ?)`,
		"brekkie eggs", target.ID).Error)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "brekkie eggs", nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, MatchAlias, cands[0].MatchTier)
	require.InDelta(t, 1.0, cands[0].MatchScore, 0.0001)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -run 'TestResolveBreaksTies|TestResolveScoreIsNotFloored|TestResolveAliasKeepsExactScore' -v`

Expected: FAIL. `TestResolveBreaksTiesThatTsRankCannot` fails on the strictly-descending assertion (all full-text scores equal ~0.72615); `TestResolveScoreIsNotFloored` fails because the score is clamped to ≥0.70.

- [ ] **Step 3: Replace the scoring half of `Resolve`**

In `api/internal/nutrition/repository.go`, add `"sort"` to the imports and remove `"math"` if it becomes unused.

Replace the **Tier 2** block (currently `repository.go:163-190`, from the `// Tier 2:` comment through the closing brace of the `for _, row := range ftRows` loop) and the **Tier 3** block (currently `:192-215`) and the truncation (`:217-220`) with:

```go
	// Non-alias candidates are pooled and scored comparably, then sorted. A
	// row found by BOTH full-text and embedding contributes its components to
	// one entry rather than appearing twice.
	pool := map[uuid.UUID]*scoredItem{}
	var order []uuid.UUID
	poolAdd := func(it FoodItem) *scoredItem {
		if s, ok := pool[it.ID]; ok {
			return s
		}
		s := &scoredItem{item: it}
		s.comp.Coverage, s.comp.Precision = tokenOverlap(norm, it.NormalizedName)
		pool[it.ID] = s
		order = append(order, it.ID)
		return s
	}

	// Tier 2: full-text on normalized_name. Both sides go through Normalize
	// (which singularizes, e.g. "oats" -> "oat") so a plural query matches a
	// plural document name.
	//
	// ts_rank is NOT used for scoring. With the default normalization flag it
	// ignores document length, and plainto_tsquery ANDs every term, so its
	// value depends only on how many terms the query had — it is identical for
	// every candidate and cannot rank them. The predicate is kept for recall;
	// similarity() supplies the signal.
	type ftRow struct {
		FoodItem
		Trgm float64 `gorm:"column:trgm"`
	}
	var ftRows []ftRow
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.*, similarity(fi.normalized_name, ?) AS trgm
		     FROM food_items fi
		     WHERE to_tsvector('simple', fi.normalized_name) @@ plainto_tsquery('simple', ?)
		     LIMIT ?`, norm, norm, limit).
		Scan(&ftRows).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve fulltext: %w", err)
	}
	for _, row := range ftRows {
		if seen[row.FoodItem.ID] {
			continue
		}
		poolAdd(row.FoodItem).comp.Trigram = row.Trgm
	}

	// Tier 3: embedding cosine (optional). This has always run whenever
	// queryVec != nil; previously its rows were appended after full-text and
	// silently cut by the limit, so the scan was paid for and discarded.
	if queryVec != nil {
		type embRow struct {
			FoodItem
			Distance float64 `gorm:"column:distance"`
			Trgm     float64 `gorm:"column:trgm"`
		}
		var embRows []embRow
		if err := r.db.WithContext(ctx).
			Raw(`SELECT fi.*, (fi.embedding <=> ?) AS distance,
			            similarity(fi.normalized_name, ?) AS trgm
			     FROM food_items fi
			     WHERE fi.embedding IS NOT NULL
			     ORDER BY distance ASC LIMIT ?`,
				pgvector.NewVector(queryVec), norm, limit).
			Scan(&embRows).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve embedding: %w", err)
		}
		for _, row := range embRows {
			if seen[row.FoodItem.ID] {
				continue
			}
			s := poolAdd(row.FoodItem)
			s.comp.Trigram = row.Trgm
			if sim := 1 - row.Distance; sim > 0 {
				s.comp.EmbSim = sim
			}
		}
	}

	// Score, sort, then scale by ambiguity. The factor is computed from the
	// top two NON-alias qualities and applied uniformly to them, which
	// preserves their relative order while letting a near-tie pull the whole
	// group below the confirm floor.
	scoredList := make([]*scoredItem, 0, len(order))
	for _, id := range order {
		s := pool[id]
		s.score = quality(s.comp)
		scoredList = append(scoredList, s)
	}
	sort.SliceStable(scoredList, func(i, j int) bool {
		return scoredList[i].score > scoredList[j].score
	})

	factor := 1.0
	if len(scoredList) > 1 {
		factor = ambiguityFactor(scoredList[0].score - scoredList[1].score)
	}
	for _, s := range scoredList {
		tier := MatchFullText
		if embeddingFactor*s.comp.EmbSim > lexical(s.comp) {
			tier = MatchEmbedding
		}
		out = append(out, Candidate{
			Item:       s.item,
			MatchScore: s.score * factor,
			MatchTier:  tier,
		})
	}

	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// scoredItem accumulates one candidate's signals across the full-text and
// embedding queries before a single score is computed from them.
type scoredItem struct {
	item  FoodItem
	comp  components
	score float64
}
```

Leave the alias tier (`repository.go:105-161`) and the `add`/`seen` helpers exactly as they are. Alias candidates are appended to `out` at `1.0` before this block and are never placed in `pool`, which is what exempts them from the ambiguity factor.

- [ ] **Step 4: Run the full nutrition suite**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -v`

Expected: PASS, including the three new tests and every pre-existing one.

If a pre-existing test asserts a score in the old 0.70–0.99 band, that test encoded the bug. Update it to assert the new behaviour and say so in the commit — do not weaken the new assertions to accommodate it.

- [ ] **Step 5: Run the AI package suite**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/ai/ -v`

Expected: PASS. `TierFor` is untouched; this confirms no resolver-level fixture depended on the old constant scores.

- [ ] **Step 6: Commit**

```bash
git add api/internal/nutrition/repository.go api/internal/nutrition/resolve_test.go
git commit -m "feat(api): score and rank food candidates by real similarity"
```

---

### Task 4: Golden set and calibration harness

**Files:**
- Create: `api/internal/nutrition/testdata/golden_queries.json`
- Create: `api/internal/nutrition/calibration_test.go`

**Interfaces:**
- Consumes: `Resolve` from Task 3.
- Produces: `CALIBRATION_DATABASE_URL`-gated tests, and a printed score distribution used by Task 5 to set the floors.

**The golden set is written from the phrases, not the code** — so weights cannot be reverse-fitted to it. It is gated on a separate database because the Go suite needs a clean `food_items` and the full index would break it.

- [ ] **Step 1: Create the calibration database and ingest the real index**

```bash
docker exec kora-pg-test psql -U kora -d kora -c "CREATE DATABASE kora_calib;"
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' go run ./cmd/migrate up
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' go run ./cmd/ingest -backfill-normalized
```

Verify the row count matches prod:

```bash
docker exec kora-pg-test psql -U kora -d kora_calib -t -A -c "SELECT count(*) FROM food_items;"
```

Expected: ~7,856. If it is 85, the SR Legacy file did not load — check `api/data/food/usda_sr_legacy.json` is present and re-run before continuing. **Do not proceed with a small index**; every number Task 5 produces would be meaningless.

- [ ] **Step 2: Derive the expected item for each query**

The query list and tier bands below are fixed. The `expect_name` values must be read out of the real index, because a golden set asserting names that do not exist proves nothing.

For each query, run:

```bash
docker exec kora-pg-test psql -U kora -d kora_calib -t -A -F'|' -c "
SELECT name FROM food_items
WHERE to_tsvector('simple',normalized_name) @@ plainto_tsquery('simple','<QUERY>')
ORDER BY similarity(normalized_name,'<QUERY>') DESC LIMIT 5;"
```

Record the name a **human would pick** as correct — not necessarily the top row. That judgement is the point of a golden set.

Create `api/internal/nutrition/testdata/golden_queries.json` with one object per query:

```json
[
  {"query": "paneer",          "expect_name": "<from index>", "expect_tier": "confirm", "band": "unambiguous"},
  {"query": "dal tadka",       "expect_name": "<from index>", "expect_tier": "confirm", "band": "unambiguous"},
  {"query": "biryani",         "expect_name": "<from index>", "expect_tier": "confirm", "band": "unambiguous"},
  {"query": "lasagne",         "expect_name": "<from index>", "expect_tier": "confirm", "band": "unambiguous"},
  {"query": "chicken breast",  "expect_name": "<from index>", "expect_tier": "follow_up", "band": "ambiguous"},
  {"query": "rice",            "expect_name": "<from index>", "expect_tier": "follow_up", "band": "ambiguous"},
  {"query": "milk",            "expect_name": "<from index>", "expect_tier": "follow_up", "band": "ambiguous"},
  {"query": "xylophone stew",  "expect_name": "",             "expect_tier": "follow_up", "band": "absent"}
]
```

Complete the file to **at least 40 entries** using these bands:

- **unambiguous (≥15)** — a clearly best row exists. Draw from the #72-verified set (`paneer`, `dal tadka`, `biryani`, `lasagne`, `dosa`, `idli`, `samosa`, `vegemite`, `weet-bix`, `lamington`) plus distinctive staples (`rolled oats`, `greek yogurt`, `peanut butter`, `cheddar cheese`, `olive oil`).
- **ambiguous (≥12)** — many near-identical rows. Single-word staples with heavy SR Legacy duplication: `chicken breast`, `rice`, `milk`, `bread`, `cheese`, `beef`, `egg`, `potato`, `yogurt`, `pasta`, `apple`, `oil`.
- **absent (≥5)** — plausible foods genuinely not in the index; verify each returns nothing before adding it.
- **regression (≥3)** — `chicken breast` must outrank `fast foods fried chicken breast`; add two more pairs found while inspecting the index.

- [ ] **Step 3: Write the calibration test**

Create `api/internal/nutrition/calibration_test.go`:

```go
package nutrition

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type goldenCase struct {
	Query      string `json:"query"`
	ExpectName string `json:"expect_name"`
	ExpectTier string `json:"expect_tier"`
	Band       string `json:"band"`
}

// tierOf mirrors ai.TierFor's thresholds. It is duplicated rather than
// imported because internal/ai imports internal/nutrition, and importing back
// would be a cycle. TestCalibrationFloorsMatchAI guards the duplication.
func tierOf(score float64) string {
	switch {
	case score >= 0.90:
		return "auto"
	case score >= 0.70:
		return "confirm"
	}
	return "follow_up"
}

func calibrationDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("CALIBRATION_DATABASE_URL")
	if url == "" {
		t.Skip("CALIBRATION_DATABASE_URL unset; see docs/superpowers/plans/2026-08-02-food-match-scoring.md Task 4")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	var n int64
	require.NoError(t, db.Raw("SELECT count(*) FROM food_items").Scan(&n).Error)
	require.Greater(t, n, int64(7000),
		"calibration DB has %d rows; it must hold the full index or every number here is meaningless", n)
	return db
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden_queries.json")
	require.NoError(t, err)
	var cases []goldenCase
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.GreaterOrEqual(t, len(cases), 40, "golden set must cover at least 40 queries")

	// The plan ships expect_name as "<from index>" placeholders to be filled in
	// from the real index. An unreplaced one would make the accuracy test
	// silently assert nothing.
	bands := map[string]int{}
	for _, c := range cases {
		require.NotContains(t, c.ExpectName, "<from index>",
			"golden case %q still has an unreplaced expect_name placeholder", c.Query)
		require.NotEmpty(t, c.Query)
		require.Contains(t, []string{"auto", "confirm", "follow_up"}, c.ExpectTier,
			"golden case %q has an invalid expect_tier %q", c.Query, c.ExpectTier)
		bands[c.Band]++
	}
	require.GreaterOrEqual(t, bands["unambiguous"], 15, "unambiguous band too small")
	require.GreaterOrEqual(t, bands["ambiguous"], 12, "ambiguous band too small")
	require.GreaterOrEqual(t, bands["absent"], 5, "absent band too small")
	return cases
}

type goldenResult struct {
	c     goldenCase
	score float64
	top   string
	tier  string
}

func runGolden(t *testing.T) []goldenResult {
	t.Helper()
	repo := NewRepository(calibrationDB(t))
	cases := loadGolden(t)
	out := make([]goldenResult, 0, len(cases))
	for _, c := range cases {
		cands, err := repo.Resolve(context.Background(), uuid.Nil, c.Query, nil, 5)
		require.NoError(t, err)
		r := goldenResult{c: c, tier: "follow_up"}
		if len(cands) > 0 {
			r.score = cands[0].MatchScore
			r.top = cands[0].Item.Name
			r.tier = tierOf(r.score)
		}
		out = append(out, r)
	}
	return out
}

// TestCalibrationReport prints the distribution Task 5 uses to set the floors.
// It asserts nothing beyond the run succeeding — reading it is the point.
func TestCalibrationReport(t *testing.T) {
	results := runGolden(t)
	sort.Slice(results, func(i, j int) bool { return results[i].score > results[j].score })
	fmt.Printf("\n%-28s %-12s %-9s %-10s %s\n", "QUERY", "BAND", "SCORE", "TIER", "TOP MATCH")
	for _, r := range results {
		fmt.Printf("%-28s %-12s %-9.4f %-10s %s\n", r.c.Query, r.c.Band, r.score, r.tier, r.top)
	}
	byBand := map[string][]float64{}
	for _, r := range results {
		byBand[r.c.Band] = append(byBand[r.c.Band], r.score)
	}
	fmt.Printf("\n%-12s %-6s %-9s %-9s %s\n", "BAND", "N", "MIN", "MAX", "MEAN")
	for band, scores := range byBand {
		min, max, sum := scores[0], scores[0], 0.0
		for _, s := range scores {
			if s < min {
				min = s
			}
			if s > max {
				max = s
			}
			sum += s
		}
		fmt.Printf("%-12s %-6d %-9.4f %-9.4f %.4f\n", band, len(scores), min, max, sum/float64(len(scores)))
	}
}

// TestGoldenSetAccuracy checks top-1 correctness on the bands where a correct
// answer exists.
func TestGoldenSetAccuracy(t *testing.T) {
	results := runGolden(t)
	correct, total := 0, 0
	var misses []string
	for _, r := range results {
		if r.c.Band == "absent" || r.c.ExpectName == "" {
			continue
		}
		total++
		if r.top == r.c.ExpectName {
			correct++
		} else {
			misses = append(misses, fmt.Sprintf("%q → got %q, want %q", r.c.Query, r.top, r.c.ExpectName))
		}
	}
	t.Logf("top-1 accuracy: %d/%d", correct, total)
	for _, m := range misses {
		t.Logf("  miss: %s", m)
	}
	require.GreaterOrEqual(t, float64(correct)/float64(total), 0.80,
		"top-1 accuracy below 80%%; the formula is picking the wrong row")
}

// TestTiersAreNotDegenerate is the test whose absence let a correct, tested,
// deployed tier system sit completely inert in production. Every resolve
// returned match_tier full_text, score 0.717-0.726, tier confirm.
func TestTiersAreNotDegenerate(t *testing.T) {
	results := runGolden(t)

	seenTiers := map[string]int{}
	min, max := 1.0, 0.0
	for _, r := range results {
		seenTiers[r.tier]++
		if r.score < min {
			min = r.score
		}
		if r.score > max {
			max = r.score
		}
	}
	t.Logf("tier distribution: %v, score range [%.4f, %.4f]", seenTiers, min, max)

	require.Greater(t, seenTiers["follow_up"], 0,
		"no query reached follow_up — the tier system is inert, which is the exact bug this work exists to fix")
	require.Greater(t, seenTiers["confirm"], 0, "no query reached confirm")
	require.Greater(t, max-min, 0.30,
		"score range is only %.4f wide; scores are still effectively constant", max-min)
}

// TestAmbiguousQueriesAskRatherThanGuess is the user-visible payoff: a query
// with many near-identical candidates must produce a question, not a guess.
func TestAmbiguousQueriesAskRatherThanGuess(t *testing.T) {
	results := runGolden(t)
	asked, total := 0, 0
	for _, r := range results {
		if r.c.Band != "ambiguous" {
			continue
		}
		total++
		if r.tier == "follow_up" {
			asked++
		} else {
			t.Logf("  %q scored %.4f (%s) — expected follow_up", r.c.Query, r.score, r.tier)
		}
	}
	require.Greater(t, total, 0, "golden set has no ambiguous band")
	require.GreaterOrEqual(t, float64(asked)/float64(total), 0.70,
		"only %d/%d ambiguous queries reached follow_up", asked, total)
}
```

- [ ] **Step 4: Run the calibration report**

Run:

```bash
cd api && CALIBRATION_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' \
  go test ./internal/nutrition/ -run 'TestCalibrationReport' -v 2>&1 | tail -70
```

Expected: a printed per-query table and per-band summary. Read it. The `unambiguous` band should sit clearly above the `ambiguous` band; if the two overlap heavily, **stop and report that** — it is a finding about the formula, not a reason to pick tidy-looking floors.

- [ ] **Step 5: Run the assertions**

Run:

```bash
cd api && CALIBRATION_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' \
  go test ./internal/nutrition/ -run 'TestGoldenSetAccuracy|TestTiersAreNotDegenerate|TestAmbiguousQueriesAskRatherThanGuess' -v
```

Expected: PASS. If `TestTiersAreNotDegenerate` fails, the change has not achieved its goal — do not adjust the assertion, report it.

- [ ] **Step 6: Verify the suite still skips cleanly without the calibration DB**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -v 2>&1 | grep -c SKIP`

Expected: ≥4 skips, no failures. CI has no calibration DB and must stay green.

- [ ] **Step 7: Commit**

```bash
git add api/internal/nutrition/testdata/golden_queries.json api/internal/nutrition/calibration_test.go
git commit -m "test(api): add a golden set and non-degeneracy guard for match scoring"
```

---

### Task 5: Calibrate the floors and mutation-proof the guard

**Files:**
- Modify: `api/internal/ai/types.go:43-46`
- Test: `api/internal/nutrition/calibration_test.go`

**Interfaces:**
- Consumes: the distribution printed by Task 4.
- Produces: final `tierAutoFloor` / `tierConfirmFloor`, and proof that the non-degeneracy guard fails for the right reason.

- [ ] **Step 1: Choose the floors from the measured distribution**

From the Task 4 report, find where the `unambiguous` band separates from the `ambiguous` band.

- `tierConfirmFloor` goes in the gap between them.
- `tierAutoFloor` goes where `unambiguous` queries with an exact-match row separate from the rest.

**The existing 0.90 / 0.70 may already be correct** — the floors were never the problem, and the measurement is allowed to say so. If the data supports them, change nothing and record why in the commit. Changing them to look busy is worse than leaving them.

If you do change them, edit `api/internal/ai/types.go`:

```go
const (
	tierAutoFloor    = 0.90 // ← replace with the calibrated value if the data warrants
	tierConfirmFloor = 0.70 // ← replace with the calibrated value if the data warrants
)
```

and update `tierOf` in `calibration_test.go` to match.

- [ ] **Step 2: Add the guard against the two drifting apart**

Append to `api/internal/nutrition/calibration_test.go`:

```go
// TestCalibrationFloorsMatchAI guards the tierOf duplication above. tierOf
// cannot import ai (internal/ai imports internal/nutrition, so it would be a
// cycle), and a silent drift between the two would make every calibration
// number a lie.
func TestCalibrationFloorsMatchAI(t *testing.T) {
	raw, err := os.ReadFile("../ai/types.go")
	require.NoError(t, err)
	require.Contains(t, string(raw), "tierAutoFloor    = 0.90",
		"ai.tierAutoFloor changed; update tierOf in this file to match")
	require.Contains(t, string(raw), "tierConfirmFloor = 0.70",
		"ai.tierConfirmFloor changed; update tierOf in this file to match")
}
```

If Step 1 changed the floors, use the new values in both places.

- [ ] **Step 3: Run it**

Run: `cd api && go test ./internal/nutrition/ -run TestCalibrationFloorsMatchAI -v`

Expected: PASS.

- [ ] **Step 4: Mutation-test the non-degeneracy guard**

It is not enough that the guard fails when the code breaks — **it must fail on the assertion it claims**. A previous check in this codebase appeared to pass while asserting nothing.

Restore the old behaviour faithfully. That means **two** changes, not one — the constant score alone is not the old bug, because a constant makes every margin 0 and the new ambiguity factor would then drag everything to `follow_up`, failing the guard for the wrong reason.

In `repository.go`, replace:

```go
		s.score = quality(s.comp)
```

with the old constant:

```go
		s.score = 0.7 + 0.29*(0.0991032/(0.0991032+1)) // OLD: constant, restore after
```

and neutralise the ambiguity factor, which did not exist before:

```go
	factor := 1.0 // OLD: no ambiguity scaling, restore after
	// if len(scoredList) > 1 {
	// 	factor = ambiguityFactor(scoredList[0].score - scoredList[1].score)
	// }
```

Run:

```bash
cd api && CALIBRATION_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' \
  go test ./internal/nutrition/ -run TestTiersAreNotDegenerate -v
```

Expected: **FAIL**, reproducing prod exactly — every query `confirm` at ~0.7262. The failure message must name one of the degeneracy assertions:

- `no query reached follow_up — the tier system is inert...`, or
- `score range is only 0.0000 wide; scores are still effectively constant`

If it fails on anything else — a panic, an index out of range, an unrelated `require` — **the guard is not testing what it claims**. That is the exact failure mode that let the kJ-vs-kcal check pass while asserting nothing. Fix the guard before continuing.

Also confirm `TestGoldenSetAccuracy` fails under the mutation (arbitrary tie-breaking picks wrong rows). If it still passes, the golden set is not discriminating either.

Record the exact failure message; it goes in the commit body context and Task 6's report.

- [ ] **Step 5: Revert the mutation**

Restore **both** mutations: `s.score = quality(s.comp)`, and the `factor` block back to its live form:

```go
	factor := 1.0
	if len(scoredList) > 1 {
		factor = ambiguityFactor(scoredList[0].score - scoredList[1].score)
	}
```

Run:

```bash
cd api && CALIBRATION_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_calib?sslmode=disable' \
  go test ./internal/nutrition/ -v
```

Expected: PASS, everything. Confirm with `git diff api/internal/nutrition/repository.go` that no mutation residue remains.

- [ ] **Step 6: Commit**

```bash
git add api/internal/ai/types.go api/internal/nutrition/calibration_test.go
git commit -m "test(api): calibrate tier floors against the measured score distribution"
```

---

### Task 6: Verify in production

The acceptance criterion is prod behaviour, not a green suite. A green suite is exactly what shipped this inert the first time.

**Files:** none — verification only.

- [ ] **Step 1: Confirm pg_trgm is permitted on the prod instance**

The migration will fail at deploy if it is not. Check before shipping:

```bash
kubectl -n kora exec deploy/kora-api -- sh -c 'echo "SELECT * FROM pg_available_extensions WHERE name = '"'"'pg_trgm'"'"';"' 2>/dev/null || \
  kubectl -n kora get job -o name
```

If the API image has no psql, run a one-off pod that mounts `kora-api-secrets` via `envFrom` rather than reading the secret value directly:

```bash
kubectl -n kora run pgcheck --rm -it --restart=Never --image=postgres:15-alpine \
  --overrides='{"spec":{"containers":[{"name":"pgcheck","image":"postgres:15-alpine","command":["sh","-c","psql \"$DATABASE_URL\" -c \"SELECT name, default_version FROM pg_available_extensions WHERE name='"'"'pg_trgm'"'"';\""],"envFrom":[{"secretRef":{"name":"kora-api-secrets"}}]}]}}'
```

Expected: one row. If empty, **stop** — the migration cannot succeed and needs a different approach.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(api): make match_score discriminate so confidence tiers fire" --body "$(cat <<'EOF'
## Problem

`match_score` was a constant, not a similarity. `ts_rank` with the default
normalization flag ignores document length, and `plainto_tsquery` ANDs every
term, so the rank depended only on how many terms the query had: 0.71662 for
one, 0.72615 for two. The observed 0.717–0.726 "distribution" was those two
numbers.

Three consequences, all one bug:

1. `TierFor` always returned `confirm`, so #71's per-item uncertain-row UI
   could never appear to a user.
2. `ORDER BY rank DESC` over a total tie is arbitrary order, so `cands[0]` was
   a coin flip — this, not SR Legacy's near-duplicates, is why "chicken breast"
   resolved to "Fast Foods, Fried Chicken, Breast".
3. Embedding candidates were appended after full-text and cut by the limit, so
   the pgvector scan was paid for on every resolve and discarded.

## Change

Recall is untouched. `similarity()` from pg_trgm replaces `ts_rank` as the
score, blended with token coverage and precision, scaled by how clearly the top
candidate beats the runner-up. Candidates from all tiers are pooled, scored
comparably, and sorted. The `0.7 +` clamp — which structurally guaranteed
`>= confirm` — is deleted.

Embedding is a booster that is a no-op on unembedded rows, so the 302/7,856
coverage gap cannot distort a score.

## Test plan

- [ ] Unit tests on the scoring function (no DB)
- [ ] Repository tests incl. the ts_rank tie regression
- [ ] Golden set of 40+ queries against the full 7,856-row index
- [ ] Non-degeneracy guard, mutation-verified to fail on its own assertion
- [ ] Prod resolve distribution shows a real spread across tiers

Spec: `docs/superpowers/specs/2026-08-02-food-match-scoring-design.md`
EOF
)"
```

- [ ] **Step 3: After merge and deploy, confirm the migration ran**

```bash
kubectl -n kora get jobs
kubectl -n kora logs job/kora-api-migrate --tail=30
```

Expected: the migrate job Complete with `000021` applied. **"Complete" is not "the work happened"** — read the log and confirm 000021 appears.

- [ ] **Step 4: Measure the real distribution**

Resolve a spread of phrases against prod and tabulate `match_tier`, `match_score`, and `tier`. Use the golden set's queries so the result is comparable to the calibration report. Obtain a token for `korasim3@tesserix.dev` / `KoraSim2026x` and call `POST /v1/resolve/text` for each.

Expected, and this is the acceptance criterion:

- `match_score` spans a **range**, not a band around 0.72
- at least one query returns `tier: follow_up`
- at least one returns `match_tier: embedding`
- `chicken breast` no longer returns a "Fast Foods, Fried Chicken" row as top

Anything short of that spread is **not done**, regardless of the suite.

- [ ] **Step 5: Log an ambiguous food in the simulator**

Start Metro (8081 belongs to another project, and `EXPO_PUBLIC_API_URL` is inlined at bundle time so it must be restarted, not reloaded):

```bash
cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --port 8082 --dev-client
```

Log a query from the `ambiguous` band and confirm the uncertain-row UI from #71 finally renders: `help-circle` glyph, "Not sure which — tap to confirm", no macro chips, "—" for kcal, excluded from the diary total. Tap it and confirm `FoodPicker` opens and promotes the row.

This is the first time that UI will have been visible to a user. Screenshot it.

- [ ] **Step 6: Update the handoff and memory**

Append the measured prod distribution to `docs/superpowers/HANDOFF-2026-08-02-food-index.md`, and update the `kora-tier-degenerate` memory — its "how to apply" recommends retuning the floors as option (3), which this work established is a dead end.

```bash
git add docs/superpowers/HANDOFF-2026-08-02-food-index.md
git commit -m "docs(kora): record the post-fix tier distribution measured in prod"
```

---

## Out of scope, deliberately

Recorded so they are not silently lost:

- **`cmd/embed` quota bug.** Exits 0 having embedded 302 of 7,856; Gemini's free tier caps at 100 embed calls/minute and the "entire batch failed; stopping" guard reports success. Fix by rate-limiting to ~90/min honouring the API's `retryDelay`. This improves recall, not discrimination — the scoring change is a no-op on unembedded rows, so coverage can improve later with no code change.
- **Runner-up candidates over the wire.** `resolveTopK=5` are fetched but `resolver.go:361` keeps only `cands[0]`, so a real candidate picker is impossible client-side.
- **The resolution-level `follow_up` dead-end.** `capture.tsx:277-285` discards candidates and offers only "Search manually", while asking "Which of these best matches what you ate?". This change makes that branch **more** reachable, so it is worth watching.
- **Display-vs-search names for clinical USDA rows.** The ranking fix addresses the symptom this was proposed for; revisit only if the golden set shows it is still needed.
