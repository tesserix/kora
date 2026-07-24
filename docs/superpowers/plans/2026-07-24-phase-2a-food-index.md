# Phase 2a — Food Index & Resolution Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `nutrition` package a real resolution index — pgvector-enabled schema, deterministic phrase normalization, a tiered `Resolve` search (alias → full-text → embedding), and an on-demand OpenFoodFacts barcode fallback — plus a curated ingestion pipeline. No LLM calls (the embedder + resolver service arrive in Phase 2b); the embedding tier accepts a query vector as input so it is testable now.

**Architecture:** Extend the existing `nutrition` package rather than adding new top-level packages. A migration enables `pgvector` and adds `embedding vector(768)` + `normalized_name` to `food_items`. `Resolve` runs three ranked tiers over the existing tsvector/alias indexes plus a raw cosine query. Barcode resolution hits the local index first, then the OpenFoodFacts API on a miss (behind an injectable client interface), caching the hit as a `FoodItem` row — never fabricating a row on failure. Ingestion loaders parse a small committed AFCD/USDA starter slice; the loaders accept larger files later.

**Tech Stack:** Go 1.26, GORM + `gorm.io/driver/postgres`, `github.com/pgvector/pgvector-go` (vector type + GORM/driver support), golang-migrate (embedded `//go:embed migrations/*.sql`), Postgres 15 with the `vector` extension, testify. HTTP for the OpenFoodFacts client (stdlib `net/http`).

## Global Constraints

- **Hard invariant (carried from the spec):** this layer never fabricates nutrition numbers. Every `FoodItem` comes from ingested data or a real OpenFoodFacts response. A barcode miss with a failed/empty OFF response returns *not-found*, never a placeholder row. No LLM is called in 2a.
- **pgvector everywhere Postgres runs:** the DB image must include the `vector` extension. Local dev (`infra/docker-compose.yml`) and CI (`.github/workflows/ci.yml` Postgres service) both switch to `pgvector/pgvector:pg15`. The migration runs `CREATE EXTENSION IF NOT EXISTS vector;`.
- **Embedding dimension is 768** (Gemini `text-embedding-004`) everywhere: `vector(768)`, the HNSW index, and any query vector.
- **Module path:** `github.com/tesserix/kora/api`. Packages: descriptive names, no generic `utils`.
- **Tests:** Go unit + integration. Integration tests get a DB via `TEST_DATABASE_URL` (default `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`) and **skip** when Postgres is unavailable — never fail on a missing DB. Run with `go test -race -p 1 ./...` (shared DB → serialize). Pure functions get table-driven unit tests.
- **Migrations:** additive, reversible (`.up.sql` + `.down.sql`), embedded. Next number is `000004`.
- **Errors:** wrap with `fmt.Errorf("nutrition: <op>: %w", err)`. No panics outside `main`. Repository returns standard errors; handlers map to the `httpx` envelope.
- **Commits:** conventional, single-line, no signature. Frequent commits (≥1 per task).
- **Immutability:** don't mutate input slices/structs; copy before `Create` (the existing `Insert` already does `created := item`).

## Existing code (grounding — read before Task 1)

- `api/internal/nutrition/model.go` — `FoodItem` struct + `Provenance` consts (`afcd|off|usda|label_ocr|user_estimate`).
- `api/internal/nutrition/repository.go` — `Repository{db}`, `NewRepository`, `Search` (ILIKE — replaced by `Resolve` usage in Task 6), `GetByID`, `Count`, `Insert` (dedups on barcode then name+brand; does `created := item` then `Create`).
- `api/internal/nutrition/handler.go` — `Handler{repo}`, `Search` (GET `/foods?q=`).
- `api/internal/nutrition/seed.go` + `seed_data.go` — 61 AU foods; `Seed` idempotent.
- `api/internal/nutrition/repository_test.go` — `testDB(t)` helper (uses `TEST_DATABASE_URL`, skips if down; cleanup deletes rows by provenance).
- `api/internal/database/migrations/` — `000001`–`000003`; embedded via `//go:embed migrations/*.sql` in `database/*.go`; run by `database.Migrate(url)` and `cmd/migrate`.
- `api/internal/server/router.go` — `v1.GET("/foods", nutritionHandler.Search)` inside the GIP-auth `v1` group; `Deps{DB, Verifier}`.
- `infra/docker-compose.yml` — `postgres:15-alpine`, `redis:7-alpine`.
- `.github/workflows/ci.yml` — the `api` job runs vet → migrate → `go test`; a Postgres service backs the DB tests.

## File Structure

- Modify: `infra/docker-compose.yml`, `.github/workflows/ci.yml` (pgvector image).
- Create: `api/internal/database/migrations/000004_nutrition_index.up.sql` / `.down.sql`.
- Modify: `api/internal/nutrition/model.go` (add `NormalizedName`; add `Candidate`).
- Create: `api/internal/nutrition/normalize.go` (+ test).
- Modify: `api/internal/nutrition/repository.go` (add `Resolve`, `BackfillNormalizedNames`; `Insert` sets `normalized_name`).
- Create: `api/internal/nutrition/resolve_test.go`.
- Create: `api/internal/nutrition/barcode.go` (+ `barcode_test.go`) — `OFFClient` interface, HTTP impl, `ResolveBarcode`.
- Create: `api/internal/nutrition/ingest/` — `ingest.go`, `afcd.go`, `usda.go` (+ tests) and `testdata/` fixtures.
- Create: `api/testdata/food/afcd_staples.json`, `api/testdata/food/usda_common.json` (curated starter slice).
- Create: `api/cmd/ingest/main.go`.
- Modify: `api/go.mod` / `go.sum` (add `pgvector-go`).
- Modify: `api/internal/nutrition/handler.go` + `api/internal/server/router.go` (Task 6: `/foods` uses `Resolve`).

---

## Task 1: pgvector infra + migration 000004 + model fields

**Files:**
- Modify: `infra/docker-compose.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `api/internal/database/migrations/000004_nutrition_index.up.sql`
- Create: `api/internal/database/migrations/000004_nutrition_index.down.sql`
- Modify: `api/internal/nutrition/model.go`
- Modify: `api/go.mod` (via `go get`)
- Test: `api/internal/nutrition/migration_test.go`

**Interfaces:**
- Produces: `food_items` gains `embedding vector(768)` (nullable) + `normalized_name TEXT NOT NULL DEFAULT ''`, an HNSW cosine index on `embedding`, and a btree index on `normalized_name`. `FoodItem` struct gains `NormalizedName string`.

- [ ] **Step 1: Add the pgvector Go dependency**

```bash
cd api && go get github.com/pgvector/pgvector-go@latest
```
Expected: `go.mod` gains `github.com/pgvector/pgvector-go`.

- [ ] **Step 2: Switch the local + CI Postgres image to pgvector**

In `infra/docker-compose.yml`, change the postgres service image:
```yaml
    image: pgvector/pgvector:pg15
```
In `.github/workflows/ci.yml`, change the Postgres **service** image the `api` job uses from `postgres:15` (or `postgres:15-alpine`) to:
```yaml
        image: pgvector/pgvector:pg15
```
(Leave ports/env/health-check unchanged.)

- [ ] **Step 3: Write the up migration**

Create `api/internal/database/migrations/000004_nutrition_index.up.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE food_items
    ADD COLUMN embedding vector(768),
    ADD COLUMN normalized_name TEXT NOT NULL DEFAULT '';

-- Approximate backfill; precise Go-normalized values are set on write and by
-- `cmd/ingest -backfill-normalized` (Task 5).
UPDATE food_items SET normalized_name = lower(btrim(name));

CREATE INDEX idx_food_items_normalized_name ON food_items (normalized_name);
CREATE INDEX idx_food_items_embedding ON food_items
    USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 4: Write the down migration**

Create `api/internal/database/migrations/000004_nutrition_index.down.sql`:
```sql
DROP INDEX IF EXISTS idx_food_items_embedding;
DROP INDEX IF EXISTS idx_food_items_normalized_name;
ALTER TABLE food_items
    DROP COLUMN IF EXISTS normalized_name,
    DROP COLUMN IF EXISTS embedding;
-- Leave the `vector` extension installed (other objects may use it).
```

- [ ] **Step 5: Add the model field**

In `api/internal/nutrition/model.go`, add to `FoodItem` (after `Name`/`Brand`, before the macro fields is fine):
```go
	NormalizedName string `gorm:"column:normalized_name" json:"-"`
```
Do NOT add the `embedding` column to the struct — it is accessed via raw SQL only (Task 3), so GORM never has to scan a nullable vector.

- [ ] **Step 6: Write the migration test**

Create `api/internal/nutrition/migration_test.go`:
```go
package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVectorExtensionAndColumns(t *testing.T) {
	db := testDB(t) // skips if Postgres unavailable
	var ext int
	require.NoError(t, db.Raw("SELECT count(*) FROM pg_extension WHERE extname = 'vector'").Scan(&ext).Error)
	require.Equal(t, 1, ext, "vector extension must be installed (run migrations against pgvector/pgvector:pg15)")

	var cols int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM information_schema.columns WHERE table_name='food_items' AND column_name IN ('embedding','normalized_name')").
		Scan(&cols).Error)
	require.Equal(t, 2, cols)
}
```

- [ ] **Step 7: Run migrations against the local DB, then the test**

```bash
cd api
docker compose -f ../infra/docker-compose.yml up -d postgres   # pgvector image
DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' go run ./cmd/migrate
DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' go test -race -p 1 ./internal/nutrition/ -run TestVectorExtensionAndColumns -v
```
Expected: PASS. If the local Postgres was the old `postgres:15-alpine` container, recreate it from the pgvector image first (`docker compose ... up -d --force-recreate postgres`).

- [ ] **Step 8: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add infra/docker-compose.yml .github/workflows/ci.yml api/internal/database/migrations/000004_nutrition_index.up.sql api/internal/database/migrations/000004_nutrition_index.down.sql api/internal/nutrition/model.go api/internal/nutrition/migration_test.go api/go.mod api/go.sum
git commit -m "feat(api): pgvector index migration + normalized_name for food resolution"
```

---

## Task 2: Phrase normalization

**Files:**
- Create: `api/internal/nutrition/normalize.go`
- Create: `api/internal/nutrition/normalize_test.go`

**Interfaces:**
- Produces: `Normalize(phrase string) string` — deterministic: lowercase, strip punctuation to spaces, collapse whitespace, trim, and singularize a trailing `s` on words > 3 chars (skip `ss`). Pure, no I/O.

- [ ] **Step 1: Write the failing test**

Create `api/internal/nutrition/normalize_test.go`:
```go
package nutrition

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Grilled Chicken Breast", "grilled chicken breast"},
		{"  Brown   Rice  ", "brown rice"},
		{"Eggs, scrambled!", "egg scrambled"},
		{"Greek yogurt (plain)", "greek yogurt plain"},
		{"oats", "oat"},
		{"glass", "glass"}, // -ss unchanged
		{"", ""},
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd api && go test ./internal/nutrition/ -run TestNormalize`
Expected: FAIL (undefined: Normalize).

- [ ] **Step 3: Implement `normalize.go`**

```go
package nutrition

import (
	"strings"
	"unicode"
)

// Normalize reduces a food phrase to a canonical form for alias/index matching:
// lowercase, punctuation → space, collapsed whitespace, trailing-plural trimmed.
func Normalize(phrase string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(phrase) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(' ')
		}
	}
	words := strings.Fields(b.String())
	for i, w := range words {
		words[i] = singularize(w)
	}
	return strings.Join(words, " ")
}

func singularize(w string) string {
	if len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
		return w[:len(w)-1]
	}
	return w
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd api && go test ./internal/nutrition/ -run TestNormalize -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition/normalize.go api/internal/nutrition/normalize_test.go
git commit -m "feat(api): deterministic food phrase normalization"
```

---

## Task 3: Tiered `Resolve` search + normalized-name writes

**Files:**
- Modify: `api/internal/nutrition/model.go` (add `Candidate` + tier consts)
- Modify: `api/internal/nutrition/repository.go` (`Resolve`, `BackfillNormalizedNames`, `Insert` sets normalized_name)
- Create: `api/internal/nutrition/resolve_test.go`

**Interfaces:**
- Consumes: `Normalize`; `pgvector-go`.
- Produces:
  - `Candidate{Item FoodItem; MatchScore float64; MatchTier string}` where `MatchTier ∈ {MatchAlias, MatchFullText, MatchEmbedding}`.
  - `Repository.Resolve(ctx, phrase string, queryVec []float32, limit int) ([]Candidate, error)` — runs alias → full-text → (if `queryVec != nil`) embedding, merges and dedups by food_item_id, ranks alias(1.0) > full-text(ts_rank) > embedding(1-cosine_distance), caps at `limit`.
  - `Repository.BackfillNormalizedNames(ctx) (int, error)` — recomputes `normalized_name = Normalize(name)` for every row in Go; returns rows updated.
  - `Insert` now sets `created.NormalizedName = Normalize(item.Name)`.

- [ ] **Step 1: Add `Candidate` + tier consts to `model.go`**

```go
const (
	MatchAlias     = "alias"
	MatchFullText  = "full_text"
	MatchEmbedding = "embedding"
)

// Candidate is a ranked resolution result. MatchScore is normalized 0..1.
type Candidate struct {
	Item       FoodItem `json:"item"`
	MatchScore float64  `json:"match_score"`
	MatchTier  string   `json:"match_tier"`
}
```

- [ ] **Step 2: Write the failing test**

Create `api/internal/nutrition/resolve_test.go`:
```go
package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func seedFor(t *testing.T, repo Repository, items []FoodItem) {
	t.Helper()
	_, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)
}

func TestResolveAliasBeatsFullText(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })
	t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE alias = 'brekkie eggs'") })

	seedFor(t, repo, []FoodItem{
		{Name: "Scrambled eggs", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 150},
		{Name: "Egg noodles", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 130},
	})
	// alias points "brekkie eggs" -> scrambled eggs
	var scrambled FoodItem
	require.NoError(t, db.First(&scrambled, "name = ? AND brand = 'test2a'", "Scrambled eggs").Error)
	db.Exec("INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", "brekkie eggs", scrambled.ID)

	got, err := repo.Resolve(context.Background(), "brekkie eggs", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, MatchAlias, got[0].MatchTier)
	require.Equal(t, scrambled.ID, got[0].Item.ID)
	require.InDelta(t, 1.0, got[0].MatchScore, 0.001)
}

func TestResolveFullTextRanksByName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })

	seedFor(t, repo, []FoodItem{
		{Name: "Grilled chicken breast", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
		{Name: "Beef mince", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 250},
	})
	got, err := repo.Resolve(context.Background(), "chicken breast", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, "Grilled chicken breast", got[0].Item.Name)
	require.Equal(t, MatchFullText, got[0].MatchTier)
}

func TestInsertSetsNormalizedName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })
	seedFor(t, repo, []FoodItem{{Name: "Rolled Oats", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 380}})
	var it FoodItem
	require.NoError(t, db.First(&it, "name = 'Rolled Oats' AND brand = 'test2a'").Error)
	require.Equal(t, "rolled oat", it.NormalizedName)
}
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd api && go test ./internal/nutrition/ -run 'TestResolve|TestInsertSetsNormalized' -p 1`
Expected: FAIL (undefined: Resolve; NormalizedName empty).

- [ ] **Step 4: Set `normalized_name` on `Insert`**

In `repository.go` `Insert`, change the `created := item` line block to set the normalized name before `Create`:
```go
		created := item
		created.NormalizedName = Normalize(item.Name)
		if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert: %w", err)
		}
```

- [ ] **Step 5: Implement `Resolve` + `BackfillNormalizedNames`**

Add to `repository.go` (add imports `math`, `github.com/pgvector/pgvector-go`):
```go
// Resolve ranks food candidates for a phrase across three tiers:
// alias (exact normalized) > full-text (tsvector) > embedding (cosine).
// queryVec may be nil to skip the embedding tier (Phase 2a has no embedder).
func (r Repository) Resolve(ctx context.Context, phrase string, queryVec []float32, limit int) ([]Candidate, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	norm := Normalize(phrase)
	seen := map[uuid.UUID]bool{}
	var out []Candidate

	add := func(items []FoodItem, tier string, score func(FoodItem) float64) {
		for _, it := range items {
			if seen[it.ID] {
				continue
			}
			seen[it.ID] = true
			out = append(out, Candidate{Item: it, MatchScore: score(it), MatchTier: tier})
		}
	}

	// Tier 1: alias exact match on normalized alias.
	var aliasItems []FoodItem
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.* FROM food_items fi
		     JOIN food_aliases fa ON fa.food_item_id = fi.id
		     WHERE lower(btrim(fa.alias)) = ? LIMIT ?`, norm, limit).
		Scan(&aliasItems).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve alias: %w", err)
	}
	add(aliasItems, MatchAlias, func(FoodItem) float64 { return 1.0 })

	// Tier 2: full-text on name.
	type ftRow struct {
		FoodItem
		Rank float64 `gorm:"column:rank"`
	}
	var ftRows []ftRow
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.*, ts_rank(to_tsvector('simple', fi.name), plainto_tsquery('simple', ?)) AS rank
		     FROM food_items fi
		     WHERE to_tsvector('simple', fi.name) @@ plainto_tsquery('simple', ?)
		     ORDER BY rank DESC LIMIT ?`, norm, norm, limit).
		Scan(&ftRows).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve fulltext: %w", err)
	}
	// Normalize ts_rank (unbounded, typically < 1) into 0..1 via rank/(rank+1), capped below alias.
	for _, row := range ftRows {
		if seen[row.FoodItem.ID] {
			continue
		}
		seen[row.FoodItem.ID] = true
		s := row.Rank / (row.Rank + 1)
		out = append(out, Candidate{Item: row.FoodItem, MatchScore: 0.7 + 0.29*s, MatchTier: MatchFullText})
	}

	// Tier 3: embedding cosine (optional).
	if queryVec != nil {
		type embRow struct {
			FoodItem
			Distance float64 `gorm:"column:distance"`
		}
		var embRows []embRow
		if err := r.db.WithContext(ctx).
			Raw(`SELECT fi.*, (fi.embedding <=> ?) AS distance
			     FROM food_items fi
			     WHERE fi.embedding IS NOT NULL
			     ORDER BY distance ASC LIMIT ?`, pgvector.NewVector(queryVec), limit).
			Scan(&embRows).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve embedding: %w", err)
		}
		for _, row := range embRows {
			if seen[row.FoodItem.ID] {
				continue
			}
			seen[row.FoodItem.ID] = true
			sim := math.Max(0, 1-row.Distance) // cosine distance → similarity
			out = append(out, Candidate{Item: row.FoodItem, MatchScore: sim * 0.7, MatchTier: MatchEmbedding})
		}
	}

	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// BackfillNormalizedNames recomputes normalized_name for every row using the
// Go Normalize function (the migration's SQL backfill is only approximate).
func (r Repository) BackfillNormalizedNames(ctx context.Context) (int, error) {
	var items []FoodItem
	if err := r.db.WithContext(ctx).Find(&items).Error; err != nil {
		return 0, fmt.Errorf("nutrition: backfill load: %w", err)
	}
	updated := 0
	for _, it := range items {
		norm := Normalize(it.Name)
		if norm == it.NormalizedName {
			continue
		}
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("id = ?", it.ID).Update("normalized_name", norm).Error; err != nil {
			return updated, fmt.Errorf("nutrition: backfill update: %w", err)
		}
		updated++
	}
	return updated, nil
}
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `cd api && go test ./internal/nutrition/ -run 'TestResolve|TestInsertSetsNormalized' -p 1 -v`
Expected: PASS. (Tiers merge alias-first; alias score 1.0 > full-text 0.7–0.99 > embedding ≤0.7.)

- [ ] **Step 7: Commit**

```bash
git add api/internal/nutrition/model.go api/internal/nutrition/repository.go api/internal/nutrition/resolve_test.go
git commit -m "feat(api): tiered food resolution (alias > full-text > embedding)"
```

---

## Task 4: Barcode resolution with OpenFoodFacts fallback

**Files:**
- Create: `api/internal/nutrition/barcode.go`
- Create: `api/internal/nutrition/barcode_test.go`

**Interfaces:**
- Produces:
  - `OFFClient interface { Fetch(ctx, barcode string) (*FoodItem, error) }` — returns `(nil, nil)` when the product is unknown; an error only on transport failure.
  - `HTTPOFFClient` implementing it against `https://world.openfoodfacts.org/api/v2/product/<barcode>.json` (injectable `http.Client` + base URL).
  - `Repository.ResolveBarcode(ctx, off OFFClient, code string) (*FoodItem, bool, error)` — local index hit first; on miss, `off.Fetch`; on a returned item, insert (dedup) and return it with `found=true`; on unknown/empty, `found=false` with no fabricated row.

- [ ] **Step 1: Write the failing test**

Create `api/internal/nutrition/barcode_test.go`:
```go
package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type stubOFF struct {
	item *FoodItem
	err  error
}

func (s stubOFF) Fetch(_ context.Context, _ string) (*FoodItem, error) { return s.item, s.err }

func TestResolveBarcodeLocalHit(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a01"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })
	seedFor(t, repo, []FoodItem{{Name: "Local bar", Brand: "test2a", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 400}})

	item, found, err := repo.ResolveBarcode(context.Background(), stubOFF{err: assertNoCall(t)}, code)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "Local bar", item.Name)
}

func TestResolveBarcodeOFFMissEnriches(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a02"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })

	off := stubOFF{item: &FoodItem{Name: "Imported oats", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 379}}
	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "Imported oats", item.Name)
	// second call now hits locally
	var count int64
	db.Model(&FoodItem{}).Where("barcode = ?", code).Count(&count)
	require.Equal(t, int64(1), count)
}

func TestResolveBarcodeUnknownNoRow(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a03"
	item, found, err := repo.ResolveBarcode(context.Background(), stubOFF{item: nil}, code)
	require.NoError(t, err)
	require.False(t, found)
	require.Nil(t, item)
	var count int64
	db.Model(&FoodItem{}).Where("barcode = ?", code).Count(&count)
	require.Equal(t, int64(0), count)
}

// assertNoCall returns an error the stub would surface if Fetch is called; the
// local-hit test must not reach the OFF client.
func assertNoCall(t *testing.T) error { return nil }
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd api && go test ./internal/nutrition/ -run TestResolveBarcode -p 1`
Expected: FAIL (undefined: OFFClient/ResolveBarcode).

- [ ] **Step 3: Implement `barcode.go`**

```go
package nutrition

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// OFFClient fetches a product from OpenFoodFacts. It returns (nil, nil) when the
// product is unknown, and an error only on transport/decode failure.
type OFFClient interface {
	Fetch(ctx context.Context, barcode string) (*FoodItem, error)
}

// HTTPOFFClient calls the OpenFoodFacts v2 product API.
type HTTPOFFClient struct {
	BaseURL string
	Client  *http.Client
}

func NewHTTPOFFClient() HTTPOFFClient {
	return HTTPOFFClient{
		BaseURL: "https://world.openfoodfacts.org",
		Client:  &http.Client{Timeout: 4 * time.Second},
	}
}

func (c HTTPOFFClient) Fetch(ctx context.Context, barcode string) (*FoodItem, error) {
	url := fmt.Sprintf("%s/api/v2/product/%s.json?fields=product_name,brands,nutriments,serving_quantity", c.BaseURL, barcode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("nutrition: off request: %w", err)
	}
	req.Header.Set("User-Agent", "Kora/1.0 (nutrition index)")
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nutrition: off fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil // treat non-200 as unknown, not an error to the caller
	}
	var body struct {
		Status  int `json:"status"`
		Product struct {
			ProductName string `json:"product_name"`
			Brands      string `json:"brands"`
			Nutriments  struct {
				EnergyKcal100g float64 `json:"energy-kcal_100g"`
				Protein100g    float64 `json:"proteins_100g"`
				Carbs100g      float64 `json:"carbohydrates_100g"`
				Fat100g        float64 `json:"fat_100g"`
				Fiber100g      float64 `json:"fiber_100g"`
			} `json:"nutriments"`
			ServingQuantity float64 `json:"serving_quantity"`
		} `json:"product"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("nutrition: off decode: %w", err)
	}
	if body.Status != 1 || body.Product.ProductName == "" || body.Product.Nutriments.EnergyKcal100g == 0 {
		return nil, nil // unknown or unusable
	}
	code := barcode
	return &FoodItem{
		Name:           body.Product.ProductName,
		Brand:          body.Product.Brands,
		Provenance:     ProvenanceOFF,
		Barcode:        &code,
		ServingGrams:   body.Product.ServingQuantity,
		KcalPer100g:    body.Product.Nutriments.EnergyKcal100g,
		ProteinPer100g: body.Product.Nutriments.Protein100g,
		CarbsPer100g:   body.Product.Nutriments.Carbs100g,
		FatPer100g:     body.Product.Nutriments.Fat100g,
		FiberPer100g:   body.Product.Nutriments.Fiber100g,
	}, nil
}

// ResolveBarcode returns a FoodItem for a barcode: local index first, then the
// OFF client on a miss (caching the hit). Never fabricates a row.
func (r Repository) ResolveBarcode(ctx context.Context, off OFFClient, code string) (*FoodItem, bool, error) {
	var local FoodItem
	err := r.db.WithContext(ctx).First(&local, "barcode = ?", code).Error
	if err == nil {
		return &local, true, nil
	}
	item, ferr := off.Fetch(ctx, code)
	if ferr != nil {
		return nil, false, fmt.Errorf("nutrition: resolve barcode: %w", ferr)
	}
	if item == nil {
		return nil, false, nil
	}
	if _, ierr := r.Insert(ctx, []FoodItem{*item}); ierr != nil {
		return nil, false, fmt.Errorf("nutrition: resolve barcode cache: %w", ierr)
	}
	var cached FoodItem
	if err := r.db.WithContext(ctx).First(&cached, "barcode = ?", code).Error; err != nil {
		return nil, false, fmt.Errorf("nutrition: resolve barcode reload: %w", err)
	}
	return &cached, true, nil
}

var _ = uuid.Nil // keep uuid import if unused elsewhere; remove if not needed
```
(Drop the trailing `uuid` line + import if `uuid` is otherwise unused in this file.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd api && go test ./internal/nutrition/ -run TestResolveBarcode -p 1 -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition/barcode.go api/internal/nutrition/barcode_test.go
git commit -m "feat(api): barcode resolution with OpenFoodFacts on-demand fallback"
```

---

## Task 5: Curated ingestion pipeline + `cmd/ingest`

**Files:**
- Create: `api/testdata/food/afcd_staples.json`, `api/testdata/food/usda_common.json`
- Create: `api/internal/nutrition/ingest/ingest.go`, `api/internal/nutrition/ingest/loaders.go`
- Create: `api/internal/nutrition/ingest/loaders_test.go`
- Create: `api/internal/nutrition/ingest/testdata/sample.json`
- Create: `api/cmd/ingest/main.go`

**Interfaces:**
- Consumes: `nutrition.FoodItem`, `nutrition.Repository`, `nutrition.Provenance*`.
- Produces:
  - `ingest.LoadFile(path string, provenance string) ([]nutrition.FoodItem, error)` — parses a JSON array of `{name, brand?, serving_desc?, serving_grams?, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g?, barcode?}` into `FoodItem`s, stamping provenance. Validates required macro fields; rejects rows with `kcal_per_100g <= 0`.
  - `ingest.Run(ctx, repo, files map[string]string) (int, error)` — loads each `path→provenance`, `repo.Insert`s all, returns total inserted.
  - `cmd/ingest` — flags `-afcd`, `-usda` (default the committed starter slice paths), `-backfill-normalized` (calls `repo.BackfillNormalizedNames`).

- [ ] **Step 1: Create the curated starter slice**

Create `api/testdata/food/afcd_staples.json` — a small array of AU staples (author 15–20 rows from public AFCD figures; example shape):
```json
[
  {"name": "Rolled oats, raw", "serving_desc": "40 g", "serving_grams": 40, "kcal_per_100g": 379, "protein_per_100g": 13.2, "carbs_per_100g": 67.7, "fat_per_100g": 6.5, "fiber_per_100g": 10.1},
  {"name": "Chicken breast, grilled, skinless", "serving_desc": "100 g", "serving_grams": 100, "kcal_per_100g": 165, "protein_per_100g": 31, "carbs_per_100g": 0, "fat_per_100g": 3.6}
]
```
Create `api/testdata/food/usda_common.json` similarly (15–20 US common foods). Use only real, public per-100g figures. Keep both files small (fits db-f1-micro).

- [ ] **Step 2: Write the failing loader test**

Create `api/internal/nutrition/ingest/testdata/sample.json`:
```json
[
  {"name": "Test Oats", "kcal_per_100g": 379, "protein_per_100g": 13.2, "carbs_per_100g": 67.7, "fat_per_100g": 6.5},
  {"name": "Bad Row", "kcal_per_100g": 0, "protein_per_100g": 1, "carbs_per_100g": 1, "fat_per_100g": 1}
]
```
Create `api/internal/nutrition/ingest/loaders_test.go`:
```go
package ingest

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoadFileStampsProvenanceAndSkipsInvalid(t *testing.T) {
	items, err := LoadFile("testdata/sample.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)
	require.Len(t, items, 1) // "Bad Row" (kcal 0) skipped
	require.Equal(t, "Test Oats", items[0].Name)
	require.Equal(t, nutrition.ProvenanceUSDA, items[0].Provenance)
}
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestLoadFile`
Expected: FAIL (package/func missing).

- [ ] **Step 4: Implement the loader + runner**

Create `api/internal/nutrition/ingest/loaders.go`:
```go
package ingest

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type row struct {
	Name           string  `json:"name"`
	Brand          string  `json:"brand"`
	ServingDesc    string  `json:"serving_desc"`
	ServingGrams   float64 `json:"serving_grams"`
	KcalPer100g    float64 `json:"kcal_per_100g"`
	ProteinPer100g float64 `json:"protein_per_100g"`
	CarbsPer100g   float64 `json:"carbs_per_100g"`
	FatPer100g     float64 `json:"fat_per_100g"`
	FiberPer100g   float64 `json:"fiber_per_100g"`
	Barcode        string  `json:"barcode"`
}

// LoadFile parses a JSON array of food rows into FoodItems, stamping provenance
// and dropping rows without a name or a positive kcal figure.
func LoadFile(path, provenance string) ([]nutrition.FoodItem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ingest: read %s: %w", path, err)
	}
	var rows []row
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("ingest: parse %s: %w", path, err)
	}
	var items []nutrition.FoodItem
	for _, r := range rows {
		if r.Name == "" || r.KcalPer100g <= 0 {
			continue
		}
		item := nutrition.FoodItem{
			Name:           r.Name,
			Brand:          r.Brand,
			Provenance:     provenance,
			ServingDesc:    r.ServingDesc,
			ServingGrams:   r.ServingGrams,
			KcalPer100g:    r.KcalPer100g,
			ProteinPer100g: r.ProteinPer100g,
			CarbsPer100g:   r.CarbsPer100g,
			FatPer100g:     r.FatPer100g,
			FiberPer100g:   r.FiberPer100g,
		}
		if r.Barcode != "" {
			b := r.Barcode
			item.Barcode = &b
		}
		items = append(items, item)
	}
	return items, nil
}
```
Create `api/internal/nutrition/ingest/ingest.go`:
```go
package ingest

import (
	"context"
	"fmt"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// Run loads each file (path→provenance) and inserts all items, returning the
// total inserted (existing rows are skipped by the repository dedup).
func Run(ctx context.Context, repo nutrition.Repository, files map[string]string) (int, error) {
	total := 0
	for path, provenance := range files {
		items, err := LoadFile(path, provenance)
		if err != nil {
			return total, err
		}
		n, err := repo.Insert(ctx, items)
		if err != nil {
			return total, fmt.Errorf("ingest: insert %s: %w", path, err)
		}
		total += n
	}
	return total, nil
}
```

- [ ] **Step 5: Run the loader test, verify it passes**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestLoadFile -v`
Expected: PASS.

- [ ] **Step 6: Implement `cmd/ingest`**

Create `api/cmd/ingest/main.go`:
```go
package main

import (
	"context"
	"flag"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/nutrition/ingest"
)

func main() {
	afcd := flag.String("afcd", "testdata/food/afcd_staples.json", "AFCD staples JSON path")
	usda := flag.String("usda", "testdata/food/usda_common.json", "USDA common foods JSON path")
	backfill := flag.Bool("backfill-normalized", false, "recompute normalized_name for all rows")
	flag.Parse()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("ingest: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	repo := nutrition.NewRepository(db)
	ctx := context.Background()

	n, err := ingest.Run(ctx, repo, map[string]string{
		*afcd: nutrition.ProvenanceAFCD,
		*usda: nutrition.ProvenanceUSDA,
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ingest: inserted %d food items", n)

	if *backfill {
		u, err := repo.BackfillNormalizedNames(ctx)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("ingest: backfilled %d normalized names", u)
	}
}
```

- [ ] **Step 7: Build + run ingest against the local DB**

```bash
cd api
go build ./cmd/ingest
DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' go run ./cmd/ingest -backfill-normalized
```
Expected: logs "inserted N food items" and "backfilled M normalized names" without error.

- [ ] **Step 8: Commit**

```bash
git add api/testdata/food api/internal/nutrition/ingest api/cmd/ingest
git commit -m "feat(api): curated AFCD/USDA ingestion pipeline + cmd/ingest"
```

---

## Task 6: Route `/foods` through tiered resolution

**Files:**
- Modify: `api/internal/nutrition/handler.go`
- Modify: `api/internal/server/router.go` (only if handler wiring changes; the route stays `GET /v1/foods`)
- Modify: `api/internal/nutrition/repository_test.go` (only if the old `Search` test must adapt) — otherwise create `api/internal/nutrition/handler_test.go`

**Interfaces:**
- Consumes: `Repository.Resolve`.
- Produces: `GET /v1/foods?q=` returns `[]Candidate` (item + tier + score) instead of raw `[]FoodItem`, using `Resolve(ctx, q, nil, limit)` (no query embedding at this layer — the embedder is Phase 2b). The `Search` method may remain for internal callers, but the handler now uses `Resolve`.

- [ ] **Step 1: Write the failing handler test**

Create `api/internal/nutrition/handler_test.go`:
```go
package nutrition

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestFoodsEndpointReturnsCandidates(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Grilled chicken breast", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
	})
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/foods", NewHandler(repo).Search)
	req := httptest.NewRequest(http.MethodGet, "/foods?q=chicken", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data []Candidate `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data)
	require.Equal(t, "Grilled chicken breast", body.Data[0].Item.Name)
}
```
(Assumes the `httpx.OK` envelope wraps payloads under `data` — confirm against `httpx` and adjust the field name if different.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd api && go test ./internal/nutrition/ -run TestFoodsEndpointReturnsCandidates -p 1`
Expected: FAIL (handler returns raw items, not candidates).

- [ ] **Step 3: Update the handler**

In `handler.go`, change `Search` to use `Resolve`:
```go
func (h Handler) Search(c *gin.Context) {
	q := c.Query("q")
	if len(q) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "q must be at least 2 characters")
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	candidates, err := h.repo.Resolve(c.Request.Context(), q, nil, limit)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "search failed")
		return
	}
	httpx.OK(c, candidates)
}
```

- [ ] **Step 4: Run the handler test + full nutrition suite**

Run: `cd api && go test ./internal/nutrition/... -p 1`
Expected: PASS. If a prior test asserted the old raw-`FoodItem` `/foods` shape, update it to expect `[]Candidate`.

- [ ] **Step 5: Note the frontend contract change**

The mobile app's `useFoodSearch` currently expects `FoodItem[]` from `/foods`. It now receives `Candidate[]` (`{item, match_score, match_tier}`). **This is a breaking API shape change** — flag it in the task report so a follow-up mobile change (map `candidate.item`) is scheduled. Do NOT change the mobile app in this backend plan; just record it.

- [ ] **Step 6: Commit**

```bash
git add api/internal/nutrition/handler.go api/internal/nutrition/handler_test.go
git commit -m "feat(api): /foods search returns ranked resolution candidates"
```

---

## Self-Review (spec §3 / Phase 2a coverage)

- **pgvector schema (embedding + normalized_name, HNSW)** → Task 1. ✓
- **Deterministic normalization** → Task 2. ✓
- **Tiered resolution alias → full-text → embedding** → Task 3 (embedding tier accepts a query vector; generation is 2b). ✓
- **Barcode → index, miss → OFF API, cache, never fabricate** → Task 4. ✓
- **Curated AFCD/USDA ingestion (small slice, larger later) + cmd/ingest + normalized backfill** → Task 5. ✓
- **Hard invariant (no fabricated rows)** → Task 4 unknown-path test asserts zero rows; no LLM in 2a. ✓
- **pgvector in CI + local** → Task 1 image swaps. ✓
- **`/foods` improved (FTS)** → Task 6, with the mobile contract change flagged for follow-up. ✓

Deferred to 2b/2c (correct): the embedder + resolver service + tiers-from-LLM-confidence (2b); the eval harness + resolve API endpoints (2c).

## Known follow-ups this plan creates

- Mobile `useFoodSearch` must map `Candidate.item` after Task 6 (breaking `/foods` shape) — schedule in the next mobile touch or at Phase 3.
- Embedding *values* are NULL until Phase 2b backfills them; the embedding tier returns nothing until then (alias + full-text carry 2a).
- The committed AFCD/USDA slice is a small starter set; expand via `cmd/ingest -afcd/-usda <larger file>` when real datasets are available.
