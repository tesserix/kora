# Post-Log Correction — Backend Implementation Plan (PR1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-log correction loop work server-side — persist the phrase a user actually said, scope correction aliases to the user who made them, and let an edit teach (or un-teach) the food index.

**Architecture:** One additive migration adds `food_logs.input_phrase` and `food_aliases.user_id`. `nutrition.Repository.Resolve` gains a `userID` parameter and checks personal aliases before global ones. `foodlog.Service.EditLog` derives the correction phrase from the log's own stored `input_phrase` (never from the client), writes a personal alias when the food changes, and deletes that alias when the client asks to retract. A new `GET /logs/:id` gives the mobile correction sheet the fields the route params never carried.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL 15 (pgvector), golang-migrate, testify.

**Spec:** `docs/superpowers/specs/2026-07-31-kora-post-log-correction-design.md`

## Global Constraints

- Nutrition is **never** client-supplied. Every kcal/macro comes from a `nutrition.FoodItem` row. Do not add a request field that carries a macro.
- The correction phrase is **server-derived** from `food_logs.input_phrase`. A client must never be able to specify which phrase an alias is keyed on.
- Alias writes and alias retractions are **best-effort**: log the failure via `slog.WarnContext`, never fail the edit.
- Migration number is **000020**. It is the next free number; prod is at v19. Do not renumber.
- Run tests in the **foreground**. Never background a test run.
- `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable` (docker container `kora-pg-test`). Recreate with `pgvector/pgvector:pg15`, `POSTGRES_DB=kora`, `POSTGRES_USER=kora`, `POSTGRES_PASSWORD=kora_dev` if absent.
- Do **not** run `go run ./cmd/seed` — it breaks two nutrition tests.
- Full check: `cd api && go vet ./... && go test -race -p 1 -count=1 ./...`
- Conventional single-line commit messages. No `Co-Authored-By`, no signatures.
- This is PR1. The mobile UI is PR2 and gets its own plan, branched off `main` **after** this merges. Do not stack.

---

### Task 1: Migration 000020 — `input_phrase` and per-user aliases

**Files:**
- Create: `api/internal/database/migrations/000020_log_corrections.up.sql`
- Create: `api/internal/database/migrations/000020_log_corrections.down.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `food_logs.input_phrase TEXT NULL` and `food_aliases.user_id UUID NULL`; indexes `idx_food_aliases_user_alias` and `idx_food_aliases_unique`. Tasks 2–4 depend on all four.

- [ ] **Step 1: Confirm 000020 is free**

Run: `ls api/internal/database/migrations/ | tail -4`

Expected: the highest number shown is `000019_feedback`. If anything named `000020_*` already exists, **stop** and report — a duplicate migration number is what took CI down for weeks.

- [ ] **Step 2: Write the up migration**

Create `api/internal/database/migrations/000020_log_corrections.up.sql`:

```sql
-- input_phrase is the raw text the user actually said or typed, kept so a
-- later correction can teach the index which phrase resolved wrong.
-- description remains the RESOLVED food's name; these are different fields.
-- Set only for source in ('ai_text','ai_voice'); NULL everywhere else.
ALTER TABLE food_logs ADD COLUMN input_phrase TEXT;

-- user_id scopes a correction alias to the user who made it.
-- NULL means curated/global. No global rows exist today (prod count is 0 and
-- there is no seed data), so this is purely additive.
ALTER TABLE food_aliases ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_food_aliases_user_alias ON food_aliases (user_id, lower(alias));

-- Replaces the check-then-insert race in nutrition.AddAlias with a real
-- constraint. Postgres treats NULL user_id as distinct per row, so this does
-- NOT dedupe global aliases — acceptable while zero exist, and cheaper than
-- NULLS NOT DISTINCT for a case that does not occur.
CREATE UNIQUE INDEX idx_food_aliases_unique ON food_aliases (user_id, lower(alias), food_item_id);
```

- [ ] **Step 3: Write the down migration**

Create `api/internal/database/migrations/000020_log_corrections.down.sql`:

```sql
DROP INDEX IF EXISTS idx_food_aliases_unique;
DROP INDEX IF EXISTS idx_food_aliases_user_alias;
ALTER TABLE food_aliases DROP COLUMN user_id;
ALTER TABLE food_logs DROP COLUMN input_phrase;
```

- [ ] **Step 4: Verify the whole chain on a genuinely FRESH database**

An incremental apply proves nothing — the duplicate-table bug passed incrementally and died only on fresh databases. Use a throwaway container, not `kora-pg-test`:

```bash
docker run -d --name kora-pg-fresh -p 55433:5432 \
  -e POSTGRES_DB=kora -e POSTGRES_USER=kora -e POSTGRES_PASSWORD=kora_dev \
  pgvector/pgvector:pg15
sleep 5
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55433/kora?sslmode=disable' \
  go run ./cmd/migrate
```

Expected: exits 0 with no error.

- [ ] **Step 5: Verify the schema landed and the version is 20**

```bash
docker exec kora-pg-fresh psql -U kora -d kora -tAc \
  "SELECT version, dirty FROM schema_migrations"
docker exec kora-pg-fresh psql -U kora -d kora -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='food_aliases' AND column_name='user_id'"
docker exec kora-pg-fresh psql -U kora -d kora -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='food_logs' AND column_name='input_phrase'"
```

Expected: `20|f`, then `user_id`, then `input_phrase`.

- [ ] **Step 6: Tear down the fresh container and migrate the real test DB**

```bash
docker rm -f kora-pg-fresh
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' \
  go run ./cmd/migrate
```

Expected: exits 0. `kora-pg-test` is now at v20.

- [ ] **Step 7: Commit**

```bash
git add api/internal/database/migrations/000020_log_corrections.up.sql \
        api/internal/database/migrations/000020_log_corrections.down.sql
git commit -m "feat(api): add input_phrase and per-user alias scoping columns"
```

---

### Task 2: Scope correction aliases to the user who made them

**Files:**
- Modify: `api/internal/nutrition/alias.go` (whole file)
- Modify: `api/internal/nutrition/repository.go:95-127` (`Resolve` signature and tier 1)
- Modify: `api/internal/nutrition/handler.go:20-33` (`Search` call site)
- Modify: `api/internal/ai/resolver.go:248`, `api/internal/ai/resolver.go:314` (call sites)
- Test: `api/internal/nutrition/alias_test.go` (create)

**Interfaces:**
- Consumes: `food_aliases.user_id` from Task 1.
- Produces:
  - `func (r Repository) AddAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error`
  - `func (r Repository) RemoveAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error`
  - `func (r Repository) Resolve(ctx context.Context, userID uuid.UUID, phrase string, queryVec []float32, limit int) ([]Candidate, error)`
  - In all three, `uuid.Nil` for `userID` means "global aliases only".

Task 4 calls `AddAlias`/`RemoveAlias`. `foodlog.Service` reaches them through an interface it already holds (`nutrition.Repository`), so the signature must match exactly.

- [ ] **Step 1: Write the failing tests**

Create `api/internal/nutrition/alias_test.go`:

```go
package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedAliasUser inserts a bare user row and returns its id.
func seedAliasUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "alias-"+id.String(), "alias@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

// seedAliasFood inserts a food item and returns it.
func seedAliasFood(t *testing.T, db *gorm.DB, name string) FoodItem {
	t.Helper()
	item := FoodItem{Name: name + " " + uuid.NewString(), Provenance: ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestPersonalAliasResolvesForItsOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "brekkie bowl " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))

	got, err := repo.Resolve(ctx, userID, phrase, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, quinoa.ID, got[0].Item.ID)
	require.Equal(t, MatchAlias, got[0].MatchTier)
}

func TestPersonalAliasIsInvisibleToOtherUsers(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	owner := seedAliasUser(t, db)
	stranger := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "brekkie bowl " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, owner, phrase, quinoa.ID))

	got, err := repo.Resolve(ctx, stranger, phrase, nil, 5)
	require.NoError(t, err)
	for _, c := range got {
		require.NotEqual(t, quinoa.ID, c.Item.ID,
			"another user's personal alias leaked into this user's resolution")
	}
}

func TestPersonalAliasOutranksGlobalAlias(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	global := seedAliasFood(t, db, "White Rice")
	personal := seedAliasFood(t, db, "Quinoa")
	phrase := "the usual " + uuid.NewString()

	// uuid.Nil writes a curated/global alias (user_id NULL).
	require.NoError(t, repo.AddAlias(ctx, uuid.Nil, phrase, global.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, personal.ID))

	got, err := repo.Resolve(ctx, userID, phrase, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, personal.ID, got[0].Item.ID, "personal alias must be ranked first")
}

func TestAddAliasIsIdempotent(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "dupe " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		userID, phrase).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}

func TestRemoveAliasDeletesOnlyTheMatchingRow(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	other := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	rice := seedAliasFood(t, db, "Rice")
	phrase := "retract me " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, rice.ID))
	require.NoError(t, repo.AddAlias(ctx, other, phrase, quinoa.ID))

	require.NoError(t, repo.RemoveAlias(ctx, userID, phrase, quinoa.ID))

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, phrase, quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 0, n, "the targeted alias must be gone")

	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, phrase, rice.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n, "the same user's other alias must survive")

	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		other, phrase).Scan(&n).Error)
	require.EqualValues(t, 1, n, "another user's alias must survive")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -run 'Alias' -count=1`

Expected: **compile failure** — `too many arguments in call to repo.AddAlias` and `repo.RemoveAlias undefined`.

- [ ] **Step 3: Rewrite `alias.go`**

Replace the whole of `api/internal/nutrition/alias.go`:

```go
package nutrition

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// aliasOwner converts a user id into the value stored in food_aliases.user_id:
// a real id for a personal alias, SQL NULL (curated/global) for uuid.Nil.
func aliasOwner(userID uuid.UUID) any {
	if userID == uuid.Nil {
		return nil
	}
	return userID
}

// AddAlias records a correction alias mapping a user phrase to a food item,
// scoped to userID. uuid.Nil writes a curated/global alias.
//
// The alias is stored lower+trim to match idx_food_aliases_user_alias ON
// food_aliases (user_id, lower(alias)) and the alias tier in Resolve — NOT
// Normalize, which would strip punctuation/singularize and cause future
// lookups to miss. A blank alias is a no-op.
//
// Idempotent per (user_id, lower(alias), food_item_id) via ON CONFLICT against
// idx_food_aliases_unique — a real constraint rather than the check-then-insert
// this replaced, which could double-write under concurrency.
func (r Repository) AddAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(
		`INSERT INTO food_aliases (alias, food_item_id, user_id) VALUES (?, ?, ?)
		 ON CONFLICT (user_id, lower(alias), food_item_id) DO NOTHING`,
		key, foodItemID, aliasOwner(userID)).Error; err != nil {
		return fmt.Errorf("nutrition: add alias insert: %w", err)
	}
	return nil
}

// RemoveAlias deletes the personal alias (userID, alias, foodItemID). It is
// the retraction half of a correction: undoing an edit must un-teach exactly
// what that edit taught, and nothing else. Deleting a global alias is not
// supported — a blank alias or uuid.Nil owner is a no-op — so a client can
// never erase curated data. Deleting a row that is not there is not an error.
func (r Repository) RemoveAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" || userID == uuid.Nil {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(
		"DELETE FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, key, foodItemID).Error; err != nil {
		return fmt.Errorf("nutrition: remove alias: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Change `Resolve` to take a user and check personal aliases first**

In `api/internal/nutrition/repository.go`, change the signature and replace the tier-1 block. The function currently reads:

```go
func (r Repository) Resolve(ctx context.Context, phrase string, queryVec []float32, limit int) ([]Candidate, error) {
```

Change it to:

```go
// Resolve ranks food candidates for a phrase across three tiers:
// alias (exact normalized) > full-text (tsvector) > embedding (cosine).
// queryVec may be nil to skip the embedding tier.
// userID scopes the alias tier: that user's personal aliases are checked
// first, then curated/global ones. uuid.Nil means global-only.
func (r Repository) Resolve(ctx context.Context, userID uuid.UUID, phrase string, queryVec []float32, limit int) ([]Candidate, error) {
```

Then replace the tier-1 block (the `// Tier 1: alias exact match.` comment through the `add(aliasItems, ...)` line) with:

```go
	// Tier 1: alias exact match, personal before global. Aliases are stored
	// verbatim (see idx_food_aliases_user_alias ON food_aliases (user_id,
	// lower(alias))), so this compares on case/whitespace only — NOT the
	// fully Normalize()'d form, which also strips punctuation and
	// singularizes and would falsely miss aliases like "brekkie eggs" when
	// queried as "brekkie eggs".
	//
	// Personal rows are added first so that when the same phrase is aliased
	// both personally and globally, `seen` keeps the personal one and drops
	// the global duplicate. Both score 1.0: within the alias tier, order
	// carries the precedence, not the score.
	aliasKey := strings.ToLower(strings.TrimSpace(phrase))
	if userID != uuid.Nil {
		var personalItems []FoodItem
		if err := r.db.WithContext(ctx).
			Raw(`SELECT fi.* FROM food_items fi
			     JOIN food_aliases fa ON fa.food_item_id = fi.id
			     WHERE fa.user_id = ? AND lower(fa.alias) = ? LIMIT ?`, userID, aliasKey, limit).
			Scan(&personalItems).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve personal alias: %w", err)
		}
		add(personalItems, MatchAlias, func(FoodItem) float64 { return 1.0 })
	}
	var aliasItems []FoodItem
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.* FROM food_items fi
		     JOIN food_aliases fa ON fa.food_item_id = fi.id
		     WHERE fa.user_id IS NULL AND lower(fa.alias) = ? LIMIT ?`, aliasKey, limit).
		Scan(&aliasItems).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve alias: %w", err)
	}
	add(aliasItems, MatchAlias, func(FoodItem) float64 { return 1.0 })
```

- [ ] **Step 5: Update the three call sites**

In `api/internal/nutrition/handler.go`, `Search` must pass the caller's id. Replace the whole function:

```go
func (h Handler) Search(c *gin.Context) {
	q := c.Query("q")
	if len(q) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "q must be at least 2 characters")
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	// uuid.Nil when unauthenticated: global aliases only, never another
	// user's personal ones.
	userID, _ := user.IDFromContext(c)
	candidates, err := h.repo.Resolve(c.Request.Context(), userID, q, nil, limit)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "search failed")
		return
	}
	httpx.OK(c, candidates)
}
```

Add the import `"github.com/tesserix/kora/api/internal/user"` to that file.

In `api/internal/ai/resolver.go` line 248, change:

```go
		cands, err := r.foods.Resolve(ctx, guess.Food, vec, resolveTopK)
```

to:

```go
		cands, err := r.foods.Resolve(ctx, userID, guess.Food, vec, resolveTopK)
```

At line 314, change:

```go
		cands, err := r.foods.Resolve(ctx, ing.Ingredient, vec, resolveTopK)
```

to:

```go
		cands, err := r.foods.Resolve(ctx, userID, ing.Ingredient, vec, resolveTopK)
```

Both call sites already have `userID uuid.UUID` in scope — `resolveGuesses` takes it as a parameter, and the decompose path uses it for `r.record(ctx, userID, usage)` a few lines above. Do **not** pass `uuid.Nil` here: that would silently disable personal aliases in the AI path, which is the main path this feature exists to improve.

`Resolver.foods` is the concrete `nutrition.Repository` (`resolver.go:63`), not an interface, so there is no interface declaration to update in `api/internal/ai/`. Likewise `foodlog.Service.foods` is a concrete `nutrition.Repository`, so Task 4 reaches `AddAlias`/`RemoveAlias` directly.

- [ ] **Step 6: Run the alias tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/nutrition/ -run 'Alias' -count=1 -v`

Expected: PASS for all five tests.

- [ ] **Step 7: Prove `TestPersonalAliasIsInvisibleToOtherUsers` is load-bearing**

Temporarily revert the **whole** tier-1 change — replace the two new queries with the single original unscoped query:

```go
	var aliasItems []FoodItem
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.* FROM food_items fi
		     JOIN food_aliases fa ON fa.food_item_id = fi.id
		     WHERE lower(fa.alias) = ? LIMIT ?`, aliasKey, limit).
		Scan(&aliasItems).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve alias: %w", err)
	}
	add(aliasItems, MatchAlias, func(FoodItem) float64 { return 1.0 })
```

Run the same command. Expected: `TestPersonalAliasIsInvisibleToOtherUsers` **FAILS** with "another user's personal alias leaked into this user's resolution", and `TestPersonalAliasOutranksGlobalAlias` fails or is order-dependent. Then restore the scoped version and re-run to confirm PASS. A partial revert (e.g. only dropping the `user_id IS NULL` filter) is not sufficient proof.

- [ ] **Step 8: Run the full suite**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go vet ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...`

Expected: vet clean, 0 FAIL. Existing `ai` and `nutrition` tests that call `Resolve` will need their call sites updated to the new signature — do that, do not change what they assert.

- [ ] **Step 9: Commit**

```bash
git add api/internal/nutrition/ api/internal/ai/
git commit -m "feat(api): scope correction aliases to the user who made them"
```

---

### Task 3: Persist the user's original phrase on resolve-sourced logs

**Files:**
- Modify: `api/internal/foodlog/model.go` (add field)
- Modify: `api/internal/foodlog/service.go:17-25` (`LogRequest`), `:61-76` (`LogFood` construction)
- Test: `api/internal/foodlog/service_test.go` (append)

**Interfaces:**
- Consumes: `food_logs.input_phrase` from Task 1.
- Produces:
  - `FoodLog.InputPhrase *string` with JSON tag `input_phrase,omitempty`
  - `LogRequest.InputPhrase *string` with JSON tag `input_phrase`
  - `func phraseForSource(source string, phrase *string) *string`

Task 4 reads `FoodLog.InputPhrase`. Task 5 serialises it.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/foodlog/service_test.go`:

```go
func TestLogFoodPersistsInputPhraseForTextSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "brekkie eggs"
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "ai_text",
		QuantityGrams: 100, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	require.NotNil(t, log.InputPhrase)
	require.Equal(t, "brekkie eggs", *log.InputPhrase)
	require.Equal(t, item.Name, log.Description, "description stays the RESOLVED name")
}

func TestLogFoodIgnoresInputPhraseForNonResolveSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "not from a resolve"
	// A manual log has no AI guess to correct, so there is nothing to teach
	// the index with — the phrase must be dropped rather than stored.
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	require.Nil(t, log.InputPhrase)
}

func TestLogFoodPersistsInputPhraseForVoiceSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food V " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "two boiled eggs"
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "ai_voice",
		QuantityGrams: 100, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	require.NotNil(t, log.InputPhrase)
	require.Equal(t, "two boiled eggs", *log.InputPhrase)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'InputPhrase' -count=1`

Expected: **compile failure** — `unknown field InputPhrase in struct literal of type LogRequest`.

- [ ] **Step 3: Add the model field**

In `api/internal/foodlog/model.go`, add after `Provenance`:

```go
	// InputPhrase is the raw text the user said or typed, kept only for
	// resolve-sourced logs so a later correction can teach the index which
	// phrase resolved wrong. Description holds the RESOLVED food's name;
	// these are deliberately different fields.
	InputPhrase   *string    `json:"input_phrase,omitempty"`
```

- [ ] **Step 4: Add the request field and the source gate**

In `api/internal/foodlog/service.go`, add to `LogRequest` after `ClientLogMs`:

```go
	InputPhrase   *string    `json:"input_phrase"`
```

Add below `validMealSlots`:

```go
// resolveSources are the log sources that carry a user phrase worth keeping.
// A manual, memory, barcode or photo log has no phrase that resolved wrong,
// so there is nothing a correction could teach the index with.
var resolveSources = map[string]bool{"ai_text": true, "ai_voice": true}

// phraseForSource keeps a non-blank input phrase only for resolve sources,
// and only when it has content after trimming.
func phraseForSource(source string, phrase *string) *string {
	if !resolveSources[source] || phrase == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*phrase)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
```

Add `"strings"` to that file's imports.

In `LogFood`, add to the `FoodLog{...}` literal after `ClientLogMs`:

```go
		InputPhrase:   phraseForSource(source, req.InputPhrase),
```

Note this uses the resolved local `source`, not `req.Source`, so the `""` → `"manual"` default is applied first.

- [ ] **Step 5: Add `input_phrase` to the repository's Update column list**

In `api/internal/foodlog/repository.go`, add to the `Updates(map[string]any{...})` in `Update`, after `"provenance"`:

```go
			"input_phrase":   log.InputPhrase,
```

GORM's `Updates` with an explicit map writes exactly these columns, so omitting it would make `input_phrase` silently unwritable on any future edit path.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'InputPhrase' -count=1 -v`

Expected: PASS for all three.

- [ ] **Step 7: Commit**

```bash
git add api/internal/foodlog/model.go api/internal/foodlog/service.go \
        api/internal/foodlog/repository.go api/internal/foodlog/service_test.go
git commit -m "feat(api): persist the user phrase behind a resolve-sourced log"
```

---

### Task 4: Teach and un-teach the index from an edit

**Files:**
- Modify: `api/internal/foodlog/service.go:80-164` (`EditRequest`, `EditLog`)
- Modify: `api/internal/foodlog/handler.go:89-114` (`Update` — call-site only; response shape lands in Task 5)
- Test: `api/internal/foodlog/service_test.go` (append)

**Interfaces:**
- Consumes: `nutrition.Repository.AddAlias`/`RemoveAlias` (Task 2), `FoodLog.InputPhrase` (Task 3).
- Produces:
  - `type EditResult struct { Log FoodLog; AliasRecorded bool }`
  - `func (s Service) EditLog(ctx context.Context, userID, logID uuid.UUID, req EditRequest) (EditResult, error)`
  - `EditRequest.RetractCorrection bool` with JSON tag `retract_correction`
  - `EditRequest.CorrectionPhrase` is **removed**.

Task 5 reads `EditResult.AliasRecorded`.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/foodlog/service_test.go`:

```go
// seedPhraseLog creates an ai_text log for `from` carrying `phrase`.
func seedPhraseLog(t *testing.T, db *gorm.DB, userID uuid.UUID, from nutrition.FoodItem, phrase string) FoodLog {
	t.Helper()
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &from.ID, MealSlot: "lunch", Source: "ai_text",
		QuantityGrams: 100, InputPhrase: &phrase,
	})
	require.NoError(t, err)
	return log
}

func TestEditLogWritesPersonalAliasWhenFoodChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice C " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa C " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "the grain thing " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	svc := NewService(NewRepository(db), nutriRepo)
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	require.True(t, res.AliasRecorded)
	require.Equal(t, quinoa.ID, *res.Log.FoodItemID)

	// The alias must be keyed on the phrase the LOG carries, personal to this user.
	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}

func TestEditLogWritesNoAliasWhenLogHasNoPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice N " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa N " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	// A manual log carries no phrase, so there is nothing to teach.
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &rice.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100,
	})
	require.NoError(t, err)

	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded)

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ?", userID).Scan(&n).Error)
	require.EqualValues(t, 0, n)
}

func TestEditLogWritesNoAliasWhenOnlyPortionChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice P " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	require.NoError(t, db.Create(&rice).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", rice.ID) })

	phrase := "portion only " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	svc := NewService(NewRepository(db), nutriRepo)
	grams := 200.0
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{QuantityGrams: &grams})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded, "a portion change teaches the index nothing")
	require.Equal(t, 200.0, res.Log.QuantityGrams)
}

func TestEditLogRetractsTheAliasTheCorrectionCreated(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice R " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa R " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "undo me " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	// Correct rice -> quinoa, which teaches (phrase -> quinoa).
	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)

	// Undo: revert to rice AND un-teach what the correction taught.
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, RetractCorrection: true,
	})
	require.NoError(t, err)
	require.Equal(t, rice.ID, *res.Log.FoodItemID)

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 0, n, "the alias the correction created must be gone")
}

func TestEditLogRetractDoesNotAliasTheRevertTarget(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice RT " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa RT " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "no rebound " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, RetractCorrection: true,
	})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded, "an undo must not itself teach the index")

	// An undo that taught (phrase -> rice) would make the wrong food sticky
	// in the opposite direction — the exact trap this flag exists to avoid.
	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		userID, strings.ToLower(phrase)).Scan(&n).Error)
	require.EqualValues(t, 0, n)
}
```

Add `"strings"` to the test file's imports if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'EditLog' -count=1`

Expected: **compile failure** — `unknown field RetractCorrection`, and `res.AliasRecorded undefined` because `EditLog` returns a `FoodLog`.

- [ ] **Step 3: Replace `EditRequest` and `EditLog`**

In `api/internal/foodlog/service.go`, replace the `EditRequest` doc comment and struct with:

```go
// EditRequest carries a partial edit to an existing log. Nil/zero fields mean
// "leave unchanged", except MealSlot which, when non-empty, is validated.
// Nutrition is NEVER taken from the request — it is always recomputed from the
// (possibly new) food row.
//
// The correction phrase is NOT client-supplied: it is read from the log's own
// input_phrase, so a client cannot mint an alias for a phrase the user never
// uttered.
//
// RetractCorrection un-teaches what a previous correction on this log taught —
// it deletes the personal alias (user, log.input_phrase, CURRENT food) before
// the revert is applied. It is the undo half of a correction, and it never
// writes an alias of its own.
type EditRequest struct {
	FoodItemID        *uuid.UUID `json:"food_item_id"`
	MealSlot          string     `json:"meal_slot"`
	QuantityGrams     *float64   `json:"quantity_grams"`
	LoggedAt          *time.Time `json:"logged_at"`
	RetractCorrection bool       `json:"retract_correction"`
}

// EditResult is an edited log plus whether the edit taught the food index.
// AliasRecorded is reported rather than inferred so the client's confirmation
// copy ("Kora will remember …") can never claim a best-effort write that
// actually failed.
type EditResult struct {
	Log           FoodLog
	AliasRecorded bool
}
```

Replace the whole `EditLog` function with:

```go
func (s Service) EditLog(ctx context.Context, userID, logID uuid.UUID, req EditRequest) (EditResult, error) {
	current, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return EditResult{}, fmt.Errorf("foodlog: edit: load: %w", err)
	}

	// Retract FIRST, while current.FoodItemID still names the food the
	// previous correction taught. Doing this after the revert would delete an
	// alias for the food being reverted TO, which no correction ever created.
	if req.RetractCorrection && current.InputPhrase != nil && current.FoodItemID != nil {
		if rerr := s.foods.RemoveAlias(ctx, userID, *current.InputPhrase, *current.FoodItemID); rerr != nil {
			// Best-effort: the user's undo must still revert the log.
			slog.WarnContext(ctx, "foodlog: correction alias retraction failed",
				"error", rerr, "food_item_id", *current.FoodItemID, "user_id", userID)
		}
	}

	if req.MealSlot != "" {
		if !validMealSlots[req.MealSlot] {
			return EditResult{}, httpx.ValidationError{Message: "invalid meal_slot"}
		}
		current.MealSlot = req.MealSlot
	}
	if req.LoggedAt != nil {
		current.LoggedAt = *req.LoggedAt
	}

	foodChanged := req.FoodItemID != nil && (current.FoodItemID == nil || *req.FoodItemID != *current.FoodItemID)
	gramsChanged := req.QuantityGrams != nil && *req.QuantityGrams != current.QuantityGrams

	if req.QuantityGrams != nil {
		if *req.QuantityGrams <= 0 {
			return EditResult{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
		}
		current.QuantityGrams = *req.QuantityGrams
	}
	if req.FoodItemID != nil {
		current.FoodItemID = req.FoodItemID
	}

	// Recompute nutrition from the row whenever food or grams changed.
	if foodChanged || gramsChanged {
		if current.FoodItemID == nil {
			return EditResult{}, httpx.ValidationError{Message: "food_item_id required to recompute nutrition"}
		}
		item, err := s.foods.GetByID(ctx, *current.FoodItemID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// The LOG exists (loaded above); it's the FOOD that's missing —
				// a client-supplied bad food_item_id, not a "log not found" case.
				return EditResult{}, httpx.ValidationError{Message: "food_item_id not found"}
			}
			return EditResult{}, fmt.Errorf("foodlog: edit: resolve food: %w", err)
		}
		f := current.QuantityGrams / 100.0
		current.Description = item.Name
		current.Kcal = item.KcalPer100g * f
		current.ProteinG = item.ProteinPer100g * f
		current.CarbsG = item.CarbsPer100g * f
		current.FatG = item.FatPer100g * f
		current.FiberG = item.FiberPer100g * f
		current.Provenance = item.Provenance
	}

	updated, err := s.logs.Update(ctx, current)
	if err != nil {
		return EditResult{}, err
	}

	// Teach the index: map the phrase that resolved wrong to the corrected
	// item, personal to this user, so their future resolves hit the alias
	// tier. An undo never teaches. Best-effort — an alias write must not fail
	// the edit.
	aliasRecorded := false
	if foodChanged && !req.RetractCorrection && current.InputPhrase != nil && current.FoodItemID != nil {
		if aerr := s.foods.AddAlias(ctx, userID, *current.InputPhrase, *current.FoodItemID); aerr != nil {
			slog.WarnContext(ctx, "foodlog: correction alias write failed",
				"error", aerr, "food_item_id", *current.FoodItemID, "user_id", userID)
		} else {
			aliasRecorded = true
		}
	}
	return EditResult{Log: updated, AliasRecorded: aliasRecorded}, nil
}
```

- [ ] **Step 4: Fix the handler call site**

In `api/internal/foodlog/handler.go`, `Update` currently ends `httpx.OK(c, updated)`. Change the call and the variable:

```go
	res, err := h.svc.EditLog(c.Request.Context(), userID, logID, req)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res.Log)
```

The `meta` envelope lands in Task 5; this step only keeps the package compiling.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'EditLog' -count=1 -v`

Expected: PASS for all five new tests. Existing `EditLog` tests will fail to compile against the new return type — update their call sites to use `res.Log`, and delete any assertion on the removed `CorrectionPhrase` field. Do not weaken what they assert otherwise.

- [ ] **Step 6: Prove `TestEditLogRetractsTheAliasTheCorrectionCreated` is load-bearing**

Temporarily move the **entire** retraction block from the top of `EditLog` to just before `return EditResult{...}` at the bottom (after `current.FoodItemID` has been overwritten with the revert target). Run the same command.

Expected: the test **FAILS** with a count of 1 — the alias for quinoa survives because the misplaced retraction deleted an alias keyed on rice instead. Then restore the block to the top and re-run to confirm PASS. Deleting the block entirely is a weaker proof: it does not show that *ordering* is what makes it correct.

- [ ] **Step 7: Run the full suite**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go vet ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...`

Expected: vet clean, 0 FAIL.

- [ ] **Step 8: Commit**

```bash
git add api/internal/foodlog/
git commit -m "feat(api): teach and retract food aliases from a log correction"
```

---

### Task 5: `GET /logs/:id` and the `alias_recorded` response meta

**Files:**
- Modify: `api/internal/httpx/respond.go` (add `OKWithMeta`)
- Modify: `api/internal/foodlog/handler.go` (add `Get`, change `Update`'s response)
- Modify: `api/internal/server/router.go:91` (add the route)
- Test: `api/internal/foodlog/handler_test.go` (append)

**Interfaces:**
- Consumes: `EditResult` (Task 4), `FoodLog.InputPhrase` (Task 3).
- Produces:
  - `func OKWithMeta(c *gin.Context, data any, meta any)` → `{"data": …, "meta": …}`
  - `func (h Handler) Get(c *gin.Context)` on `GET /v1/logs/:id`
  - `PATCH /v1/logs/:id` → `{"data": <FoodLog>, "meta": {"alias_recorded": bool}}`

PR2's `useLog(id)` hook consumes `GET /v1/logs/:id`; its undo path consumes `meta.alias_recorded`.

- [ ] **Step 1: Write the failing tests**

`handler_test.go` has no shared router helper today — each test builds a router inline with `gin.New()` and `r.Use(func(c *gin.Context) { c.Set("user_id", u.ID); c.Next() })` (see `handler_test.go:121-123`). Add one helper so these four tests do not repeat it, then the tests.

Append to `api/internal/foodlog/handler_test.go`:

```go
// newAuthedRouter builds a router with the /v1/logs routes under test, with
// userID already in the Gin context the way user.IDFromContext reads it —
// the same inline pattern the older tests in this file use, factored out.
func newAuthedRouter(t *testing.T, db *gorm.DB, userID uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := NewRepository(db)
	h := NewHandler(NewService(repo, nutrition.NewRepository(db)), repo)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	r.GET("/v1/logs/:id", h.Get)
	r.PATCH("/v1/logs/:id", h.Update)
	return r
}
```

`seedUser` and `seedPhraseLog` live in `service_test.go` in the same package, so they are directly callable here. Then append the tests:

```go
func TestGetLogReturnsFullRecordIncludingInputPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Get Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	phrase := "get me " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, item, phrase)

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/logs/"+log.ID.String(), nil))

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			ID          string  `json:"id"`
			FoodItemID  *string `json:"food_item_id"`
			InputPhrase *string `json:"input_phrase"`
			Source      string  `json:"source"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, log.ID.String(), body.Data.ID)
	require.NotNil(t, body.Data.FoodItemID, "the correction sheet needs food_item_id")
	require.NotNil(t, body.Data.InputPhrase)
	require.Equal(t, phrase, *body.Data.InputPhrase)
	require.Equal(t, "ai_text", body.Data.Source)
}

func TestGetLogIsNotFoundForAnotherUsersLog(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	stranger := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Get Food O " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	log := seedPhraseLog(t, db, owner, item, "private "+uuid.NewString())

	r := newAuthedRouter(t, db, stranger)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/logs/"+log.ID.String(), nil))

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestPatchLogReportsAliasRecordedInMeta(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	rice := nutrition.FoodItem{Name: "Rice M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	log := seedPhraseLog(t, db, userID, rice, "meta phrase "+uuid.NewString())

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	body := `{"food_item_id":"` + quinoa.ID.String() + `"}`
	req := httptest.NewRequest(http.MethodPatch, "/v1/logs/"+log.ID.String(), strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var parsed struct {
		Data struct {
			FoodItemID string `json:"food_item_id"`
		} `json:"data"`
		Meta struct {
			AliasRecorded bool `json:"alias_recorded"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))
	require.Equal(t, quinoa.ID.String(), parsed.Data.FoodItemID)
	require.True(t, parsed.Meta.AliasRecorded)
}

func TestPatchLogReportsNoAliasForPortionOnlyEdit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	rice := nutrition.FoodItem{Name: "Rice MP " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	require.NoError(t, db.Create(&rice).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", rice.ID) })

	log := seedPhraseLog(t, db, userID, rice, "meta portion "+uuid.NewString())

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/logs/"+log.ID.String(),
		strings.NewReader(`{"quantity_grams":250}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var parsed struct {
		Meta struct {
			AliasRecorded bool `json:"alias_recorded"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))
	require.False(t, parsed.Meta.AliasRecorded)
}
```

Ensure the file imports `encoding/json`, `net/http`, `net/http/httptest`, `strings`, `gorm.io/gorm`, `github.com/gin-gonic/gin`, `github.com/google/uuid` and the `nutrition` package. Most are already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'TestGetLog|TestPatchLog' -count=1`

Expected: 404 on the GET tests (route not registered) and `Meta.AliasRecorded` false on the PATCH test (no `meta` key in the body).

- [ ] **Step 3: Add `OKWithMeta`**

Append to `api/internal/httpx/respond.go`:

```go
// OKWithMeta responds with the standard data envelope plus a meta object, for
// the few endpoints that must report something about the operation that is not
// part of the resource itself. Additive: OK's shape is unchanged.
func OKWithMeta(c *gin.Context, data any, meta any) {
	c.JSON(200, gin.H{"data": data, "meta": meta})
}
```

- [ ] **Step 4: Add the `Get` handler and switch `Update` to the meta envelope**

In `api/internal/foodlog/handler.go`, add after `List`:

```go
// Get returns one log in full. The diary passes a meal's fields as route
// params, which cannot carry food_item_id, source or input_phrase — the
// correction sheet needs all three, so it re-reads the record here.
func (h Handler) Get(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	log, err := h.repo.GetByID(c.Request.Context(), userID, logID)
	if err != nil {
		// GetByID scopes by (id AND user_id), so another user's log is
		// indistinguishable from a missing one — deliberately, as with Delete.
		httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
		return
	}
	httpx.OK(c, log)
}
```

In `Update`, change the final line from `httpx.OK(c, res.Log)` to:

```go
	httpx.OKWithMeta(c, res.Log, gin.H{"alias_recorded": res.AliasRecorded})
```

- [ ] **Step 5: Register the route**

In `api/internal/server/router.go`, add after `v1.GET("/logs", logHandler.List)`:

```go
		v1.GET("/logs/:id", logHandler.Get)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'TestGetLog|TestPatchLog' -count=1 -v`

Expected: PASS for all four.

- [ ] **Step 7: Run the full suite and vet**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go vet ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...`

Expected: vet clean, 0 FAIL.

- [ ] **Step 8: Verify the route table has no Gin conflict**

Run: `cd api && go build ./... && grep -n 'v1.GET("/logs' internal/server/router.go`

Expected: build succeeds and both `/logs` and `/logs/:id` are listed. Gin already mixes a wildcard and literal siblings under `/logs` (`/logs/copy-day` alongside `/logs/:id/repeat`), so this pattern is known-good in this router.

- [ ] **Step 9: Commit**

```bash
git add api/internal/httpx/respond.go api/internal/foodlog/handler.go \
        api/internal/foodlog/handler_test.go api/internal/server/router.go
git commit -m "feat(api): serve GET /v1/logs/:id and report alias_recorded on edit"
```

---

### Task 6: Fresh-database chain check and PR

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: a merged PR1.

- [ ] **Step 1: Re-verify the full chain on a fresh database**

Tasks 2–5 changed no SQL, but the chain is cheap to re-check and the cost of a broken one is weeks:

```bash
docker run -d --name kora-pg-fresh2 -p 55434:5432 \
  -e POSTGRES_DB=kora -e POSTGRES_USER=kora -e POSTGRES_PASSWORD=kora_dev \
  pgvector/pgvector:pg15
sleep 5
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55434/kora?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-fresh2 psql -U kora -d kora -tAc "SELECT version, dirty FROM schema_migrations"
docker rm -f kora-pg-fresh2
```

Expected: migrate exits 0, version is `20|f`.

- [ ] **Step 2: Run the CI-equivalent check one final time**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go vet ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...`

Expected: vet clean, 0 FAIL.

- [ ] **Step 3: Open the PR**

```bash
gh auth switch --user mahesh-sangawar
git push -u origin HEAD
gh pr create --title "feat(api): post-log correction backend — per-user aliases, input_phrase, GET /logs/:id" --body "$(cat <<'EOF'
Backend half of #20. Mobile UI follows as a separate PR off main.

## What changed
- **Migration 000020** — `food_logs.input_phrase` and `food_aliases.user_id`, both nullable and additive. No backfill.
- **Correction aliases are now per-user.** `food_aliases` had no `user_id`, so one user correcting "rice" → quinoa changed resolution for everyone, on the first correction, at the highest-scoring tier. Prod row count was 0 and there is no seed data, so this was the cheapest possible moment to fix it.
- **The user's original phrase is persisted** on `ai_text`/`ai_voice` logs. It was never stored before — `description` holds the *resolved* name — so `correction_phrase` had nothing to fill it with and the teach-the-index loop could not work at all.
- **`correction_phrase` is removed from `EditRequest`.** The server derives it from the log's own `input_phrase`, so a client cannot mint an alias for a phrase the user never uttered.
- **`retract_correction`** un-teaches what a correction taught, keyed on the food being reverted *away from*.
- **`GET /v1/logs/:id`** — the correction sheet needs `food_item_id`, `source` and `input_phrase`, none of which survive the diary's route params.
- **`PATCH /v1/logs/:id`** now returns `{"data": …, "meta": {"alias_recorded": bool}}` so the client's "Kora will remember" copy cannot claim a best-effort write that failed.

## Test plan
- [x] Migration verified against a genuinely **fresh** database to v20, not an incremental apply
- [x] Personal alias resolves for its owner, is invisible to other users, and outranks a global alias
- [x] Retraction deletes only the targeted row; same user's other aliases and other users' aliases survive
- [x] Alias written on food change only when `input_phrase` is set; never on a portion-only edit; never by an undo
- [x] `GET /logs/:id` returns 404 for another user's log
- [x] `meta.alias_recorded` reflects the actual write outcome
- [x] `go vet ./...` clean, `go test -race -p 1 -count=1 ./...` 0 FAIL

Refs #20
EOF
)"
```

- [ ] **Step 4: Report the PR URL and wait**

Do not merge. Report the PR URL and the CI status back for review.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Migration `000020` (both columns, both indexes) | 1 |
| `food_aliases.user_id`, personal-before-global tier 1 | 2 |
| `Resolve` gains `userID`, 3 call sites | 2 |
| `AddAlias`/`RemoveAlias` take `userID`; upsert replaces check-then-insert | 2 |
| `food_logs.input_phrase`, set only for text/voice | 3 |
| `LogRequest.input_phrase` | 3 |
| Remove client `correction_phrase`; server-derived | 4 |
| Automatic, immediate, personal alias write; best-effort | 4 |
| `retract_correction`, keyed on the food reverted away from, before the revert | 4 |
| `GET /logs/:id`, 404 for another user | 5 |
| `httpx.OKWithMeta`, `meta.alias_recorded` | 5 |
| Fresh-database chain verification | 1, 6 |
| Break-it-to-prove-it on load-bearing tests | 2 (step 7), 4 (step 6) |

Spec items deliberately **not** in this plan, because they are PR2 (mobile): `useLog(id)`, `useFoodSearch`, the food picker, "Ask Kora again", undo toasts, design fidelity, and the stated limitations about delete-undo and photo logs. Spec items out of scope entirely: soft delete, revision history, alias management UI, confidence tiers (#21).

**Placeholder scan:** no TBD/TODO; every code step carries real code; every command carries an expected result. Both previously-conditional steps were resolved against the codebase and are now literal: `userID` is confirmed in scope at both `ai/resolver.go` call sites, `Resolver.foods` and `Service.foods` are confirmed to be the concrete `nutrition.Repository` (so no interface needs updating), and `newAuthedRouter` is given in full rather than described.

**Type consistency:** `AddAlias(ctx, userID, alias, foodItemID)` and `RemoveAlias(ctx, userID, alias, foodItemID)` are declared in Task 2 and called with that arity in Task 4. `Resolve(ctx, userID, phrase, queryVec, limit)` is declared in Task 2 and used at three call sites in the same task. `EditResult{Log, AliasRecorded}` is declared in Task 4 and read in Tasks 4 and 5. `FoodLog.InputPhrase` and `LogRequest.InputPhrase` are both `*string`, and every read in Task 4 nil-checks before dereferencing.
