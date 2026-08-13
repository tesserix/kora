# Recipe Metadata (Tags & Steps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipes carry cooking steps and normalised, AI-suggested, user-editable tags, and the recipe list can be filtered by tag.

**Architecture:** Two tables — `recipe_tags` keyed on `(recipe_id, tag)` because tags are a set, and `recipe_steps` keyed on `(recipe_id, position)` because steps are a sequence. A pure `normalizeTag` in `internal/recipes`, both threaded through the existing save/read/parse paths, and two read endpoints — a `?tags=` filter and a tag-list-with-counts. The parse call gains both fields without gaining a request. Mobile adds a filter-chip row, a tag editor, and a method editor to the screens that already exist.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL, golang-migrate, testify. Expo/React Native, TypeScript, TanStack Query, Jest.

**Spec:** `docs/superpowers/specs/2026-08-13-kora-recipe-metadata-design.md`

## Global Constraints

- **Do NOT reuse `nutrition.Normalize` for tags.** It singularises and strips punctuation for food-index matching, which would turn `high-protein` into `high protein` and `greens` into `green`. Tags get their own normaliser.
- **Max 10 tags per recipe**; a tag is capped at **30 characters** (truncate, don't reject); a tag normalising to empty is **dropped silently**, never a validation failure.
- **Max 40 steps per recipe**; a step is capped at **500 characters** (truncate, don't reject); an empty step is dropped and the rest renumbered from list order.
- **Steps never touch any macro computation.** They are descriptive text. A recipe's totals must be identical with and without them, and there is a required test for exactly that.
- Tags render and are returned **alphabetically**, always. Steps render and are returned **in position order**, always.
- Filtering is **AND**: `?tags=a,b` returns recipes carrying both.
- **No extra AI provider call.** Tag suggestion adds fields to the existing parse response; it must not add a request.
- The nutrition invariant is unchanged: the parse prompt must not request macros, and any the model volunteers are still discarded.
- Timestamps use `gorm:"autoCreateTime"` / `autoUpdateTime`. Do NOT add explicit `updated_at` to map-based `Updates` — gorm v1.31.2 handles it (proved during #25).
- A recipe belonging to another user is a **404**, never a 403.
- All responses use the `{data}` envelope via `httpx.OK` / `httpx.Error`; 201s use `c.JSON(http.StatusCreated, gin.H{"data": v})`.
- Every mobile mutation surfaces errors via toast — never an `isPending`-gated button left disabled with no error surface (#83).
- Commit after every task. Single-line conventional commits, no signature, no `--signoff`, no Co-Authored-By trailer.
- `gofmt -l internal/recipes/` must be empty before each commit.

**Environment:** Postgres at `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`, currently at migration `000029`. Run Go commands from `api/`, mobile commands from `apps/mobile/`. `cmd/api/main.go` does NOT auto-load `.env` — use `set -a; . ./.env; set +a; go run ./cmd/api`. `npx eslint` is broken repo-wide and pre-existing; skip it. Two pre-existing test failures (`internal/nutrition` embedding tests, one `internal/ai` search test) occur when the dev food index is seeded — not yours.

---

### Task 1: Migration `000030` + `normalizeTag` + `normalizeSteps`

**Files:**
- Create: `api/internal/database/migrations/000030_recipe_metadata.up.sql`
- Create: `api/internal/database/migrations/000030_recipe_metadata.down.sql`
- Create: `api/internal/recipes/tags.go`
- Create: `api/internal/recipes/steps.go`
- Test: `api/internal/recipes/tags_test.go`
- Test: `api/internal/recipes/steps_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `recipes.Tag` and `recipes.Step` models, `normalizeTag(string) (string, bool)`, `normalizeTags([]string) []string`, `normalizeSteps([]string) []string`, constants `maxTags = 10`, `maxTagLen = 30`, `maxSteps = 40`, `maxStepLen = 500`.

- [ ] **Step 1: Write the up migration**

`api/internal/database/migrations/000030_recipe_metadata.up.sql`:

```sql
-- Tags are a SET: the composite primary key enforces per-recipe de-duplication
-- in the database rather than in application code, and needs no surrogate id.
-- There is deliberately no position column.
CREATE TABLE recipe_tags (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);

-- Carries both the ?tags= filter and the tag-list-with-counts query.
CREATE INDEX ix_recipe_tags_tag ON recipe_tags (tag);

-- Steps are a SEQUENCE: order IS the meaning, so the key is (recipe_id,
-- position), not (recipe_id, text). Two identical instructions at different
-- points in a method are legitimate and must both survive.
CREATE TABLE recipe_steps (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    text      TEXT NOT NULL,
    PRIMARY KEY (recipe_id, position)
);
```

- [ ] **Step 2: Write the down migration**

`api/internal/database/migrations/000030_recipe_metadata.down.sql`:

```sql
DROP TABLE IF EXISTS recipe_steps;
DROP TABLE IF EXISTS recipe_tags;
```

- [ ] **Step 3: Apply and verify**

Run from `api/`:

```bash
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" up
psql "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" -c "\d recipe_tags"
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" down 1
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" up
```

Expected: table listed with the composite PK, down/up cycle clean. If `psql` is unavailable, use `docker exec -i infra-postgres-1 psql -U kora -d kora -c "\d recipe_tags"`.

- [ ] **Step 4: Write the failing normaliser tests**

`api/internal/recipes/tags_test.go`:

```go
package recipes

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTag(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{"lowercases", "Vegetarian", "vegetarian", true},
		{"trims", "  dinner  ", "dinner", true},
		{"collapses internal whitespace", "high    protein", "high protein", true},
		{"keeps hyphens", "High-Protein", "high-protein", true},
		{"keeps digits", "30 minute", "30 minute", true},
		{"drops punctuation", "veg!!!, dinner?", "veg dinner", true},
		{"empty input", "", "", false},
		{"punctuation only", "!!!", "", false},
		{"whitespace only", "   ", "", false},
		{"truncates over 30 chars", "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd", "aaaaaaaaaabbbbbbbbbbcccccccccc", true},
		{"unicode letters kept", "Café", "café", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := normalizeTag(c.in)
			require.Equal(t, c.ok, ok)
			require.Equal(t, c.want, got)
		})
	}
}

// TestNormalizeTags proves the set semantics: de-duplicated, alphabetical,
// capped, with unusable entries dropped rather than failing the whole call.
func TestNormalizeTags(t *testing.T) {
	got := normalizeTags([]string{"Dinner", "dinner ", "!!!", "Vegetarian", ""})
	require.Equal(t, []string{"dinner", "vegetarian"}, got)

	require.Empty(t, normalizeTags(nil))

	many := make([]string, 0, 15)
	for _, s := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"} {
		many = append(many, s)
	}
	require.Len(t, normalizeTags(many), maxTags, "must cap at maxTags")
}

// TestNormalizeTagDoesNotSingularise pins the deliberate difference from
// nutrition.Normalize: tags are a different domain and must not be mangled by
// food-matching rules.
func TestNormalizeTagDoesNotSingularise(t *testing.T) {
	got, ok := normalizeTag("greens")
	require.True(t, ok)
	require.Equal(t, "greens", got, "tags must not be singularised")

	got, ok = normalizeTag("high-protein")
	require.True(t, ok)
	require.Equal(t, "high-protein", got, "hyphens must survive")
}
```

- [ ] **Step 5: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run TestNormalizeTag -v`
Expected: FAIL to build — `undefined: normalizeTag`.

- [ ] **Step 6: Write the model and normaliser**

`api/internal/recipes/tags.go`:

```go
package recipes

import (
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
)

const (
	// maxTags bounds a recipe's tag set. Beyond this they stop being a filter
	// and become noise.
	maxTags = 10
	// maxTagLen bounds one tag. Over-length input is TRUNCATED, not rejected —
	// a long tag is a typo, not a reason to fail someone's save.
	maxTagLen = 30
)

// Tag is one tag on one recipe. The table's composite primary key
// (recipe_id, tag) enforces de-duplication in the database, so there is no id
// column and no position: tags are a set, not a sequence.
type Tag struct {
	RecipeID uuid.UUID `gorm:"type:uuid;not null;primaryKey"`
	Tag      string    `gorm:"not null;primaryKey"`
}

func (Tag) TableName() string { return "recipe_tags" }

// normalizeTag reduces one tag to canonical form: lowercase, trimmed,
// internal whitespace collapsed, punctuation dropped, hyphens and digits kept.
// The bool reports whether anything usable survived.
//
// nutrition.Normalize is deliberately NOT reused here. It singularises and
// strips punctuation for food-index matching, which would turn "high-protein"
// into "high protein" and "greens" into "green". Tags are a different domain,
// and sharing a normaliser would mean a change to food matching silently
// rewriting users' tags.
func normalizeTag(raw string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '-':
			b.WriteRune('-')
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			// Punctuation becomes a space so "veg,dinner" splits rather than
			// fusing into one nonsense tag.
			b.WriteRune(' ')
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if out == "" {
		return "", false
	}
	if len(out) > maxTagLen {
		out = strings.TrimSpace(out[:maxTagLen])
	}
	if out == "" {
		return "", false
	}
	return out, true
}

// normalizeTags turns caller input into the canonical set stored on a recipe:
// normalised, de-duplicated, alphabetical, capped at maxTags. Entries that
// normalise to nothing are dropped silently — the user typed punctuation, not
// a tag, and failing their whole save over it would be hostile.
func normalizeTags(raw []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		t, ok := normalizeTag(r)
		if !ok {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	sort.Strings(out)
	if len(out) > maxTags {
		out = out[:maxTags]
	}
	return out
}
```

- [ ] **Step 7: Write the failing step tests**

`api/internal/recipes/steps_test.go`:

```go
package recipes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestNormalizeSteps proves the sequence semantics: order preserved, empties
// dropped, duplicates KEPT (unlike tags), over-length truncated, capped.
func TestNormalizeSteps(t *testing.T) {
	got := normalizeSteps([]string{"  Rinse the lentils ", "", "   ", "Simmer 25 minutes"})
	require.Equal(t, []string{"Rinse the lentils", "Simmer 25 minutes"}, got,
		"trimmed, empties dropped, order preserved")

	require.Empty(t, normalizeSteps(nil))

	// Duplicates are legitimate in a method — "stir" can appear twice.
	require.Equal(t, []string{"stir", "stir"}, normalizeSteps([]string{"stir", "stir"}))

	long := strings.Repeat("a", 600)
	out := normalizeSteps([]string{long})
	require.Len(t, out, 1)
	require.Len(t, out[0], maxStepLen, "over-length is truncated, not rejected")

	many := make([]string, 50)
	for i := range many {
		many[i] = "step"
	}
	require.Len(t, normalizeSteps(many), maxSteps, "must cap at maxSteps")
}
```

- [ ] **Step 8: Write the step model and normaliser**

`api/internal/recipes/steps.go`:

```go
package recipes

import (
	"strings"

	"github.com/google/uuid"
)

const (
	// maxSteps bounds a method. Beyond this it is not a recipe.
	maxSteps = 40
	// maxStepLen bounds one instruction. Over-length is TRUNCATED, not
	// rejected — a long step is prose, not an attack, and losing the user's
	// whole save over it would be hostile.
	maxStepLen = 500
)

// Step is one instruction in a recipe's method. The table keys on
// (recipe_id, position) because order IS the meaning: unlike tags, two
// identical instructions at different points are both legitimate, so the text
// cannot be part of the key.
type Step struct {
	RecipeID uuid.UUID `gorm:"type:uuid;not null;primaryKey"`
	Position int       `gorm:"not null;primaryKey"`
	Text     string    `gorm:"not null"`
}

func (Step) TableName() string { return "recipe_steps" }

// normalizeSteps trims each instruction, drops the ones that are empty
// afterwards, truncates over-length ones, and caps the list. Order is
// preserved and duplicates are kept — both are meaningful in a method.
//
// Positions are NOT assigned here: the repository rewrites them from slice
// order on write, the same rule insertIngredients already follows, so a caller
// can never desynchronise them.
func normalizeSteps(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		s := strings.TrimSpace(r)
		if s == "" {
			continue
		}
		if len(s) > maxStepLen {
			s = strings.TrimSpace(s[:maxStepLen])
		}
		if s == "" {
			continue
		}
		out = append(out, s)
		if len(out) == maxSteps {
			break
		}
	}
	return out
}
```

- [ ] **Step 9: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -run 'TestNormalize' -v` — expect PASS for both tag and step tests.
Then `go build ./... && go vet ./... && gofmt -l internal/recipes/` — expect clean.

- [ ] **Step 10: Commit**

```bash
git add api/internal/database/migrations/000030_recipe_metadata.up.sql api/internal/database/migrations/000030_recipe_metadata.down.sql api/internal/recipes/tags.go api/internal/recipes/tags_test.go api/internal/recipes/steps.go api/internal/recipes/steps_test.go
git commit -m "feat(recipes): recipe_tags and recipe_steps tables with their normalisers"
```

---

### Task 2: Repository — persist, read, filter, count

**Files:**
- Modify: `api/internal/recipes/repository.go`
- Test: `api/internal/recipes/repository_test.go`

**Interfaces:**
- Consumes: `Tag`, `Step`, `normalizeTags`, `normalizeSteps` from Task 1; existing `Repository`, `Recipe`, `Ingredient`.
- Produces, all on `Repository`:
  - `TagsForRecipes(ctx, recipeIDs []uuid.UUID) (map[uuid.UUID][]string, error)`
  - `StepsForRecipes(ctx, recipeIDs []uuid.UUID) (map[uuid.UUID][]string, error)` — ordered by `position`
  - `ListForUserFiltered(ctx, userID uuid.UUID, tags []string) ([]Recipe, error)` — empty `tags` behaves exactly like `ListForUser`
  - `TagCountsForUser(ctx, userID uuid.UUID) ([]TagCount, error)` with `type TagCount struct { Tag string; Count int }`
  - `Create` and `Replace` gain **two** new parameters, `tags []string` and `steps []string`, in that order (see step 3 for exact signatures)

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/recipes/repository_test.go`:

```go
// TestTagsPersistAndReadBack proves tags survive create and come back
// alphabetical.
func TestTagsPersistAndReadBack(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Dal", Servings: 4, Source: SourcePaste},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "lentils", Grams: 200}},
		[]string{"vegetarian", "dinner"},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	byRecipe, err := repo.TagsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Equal(t, []string{"dinner", "vegetarian"}, byRecipe[r.ID])
}

// TestListForUserFilteredIsAND proves a two-tag filter narrows rather than
// widens — the semantics a filter-chip UI implies.
func TestListForUserFilteredIsAND(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()
	ings := []Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}}

	both, err := repo.Create(ctx, Recipe{UserID: owner, Name: "Both", Servings: 1, Source: SourceManual}, ings, []string{"vegetarian", "dinner"})
	require.NoError(t, err)
	one, err := repo.Create(ctx, Recipe{UserID: owner, Name: "One", Servings: 1, Source: SourceManual}, ings, []string{"vegetarian"})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", owner) })

	got, err := repo.ListForUserFiltered(ctx, owner, []string{"vegetarian", "dinner"})
	require.NoError(t, err)
	require.Len(t, got, 1, "AND: only the recipe with BOTH tags")
	require.Equal(t, both.ID, got[0].ID)

	got, err = repo.ListForUserFiltered(ctx, owner, []string{"vegetarian"})
	require.NoError(t, err)
	require.Len(t, got, 2)

	got, err = repo.ListForUserFiltered(ctx, owner, nil)
	require.NoError(t, err)
	require.Len(t, got, 2, "no filter behaves like ListForUser")

	got, err = repo.ListForUserFiltered(ctx, owner, []string{"nonexistent"})
	require.NoError(t, err)
	require.Empty(t, got, "a filter matching nothing is a valid empty result")
	_ = one
}

// TestTagCountsScopedToOwner proves the chip list cannot leak another user's
// tags.
func TestTagCountsScopedToOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()
	ings := []Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}}

	_, err := repo.Create(ctx, Recipe{UserID: owner, Name: "A", Servings: 1, Source: SourceManual}, ings, []string{"vegetarian", "dinner"})
	require.NoError(t, err)
	_, err = repo.Create(ctx, Recipe{UserID: owner, Name: "B", Servings: 1, Source: SourceManual}, ings, []string{"vegetarian"})
	require.NoError(t, err)
	_, err = repo.Create(ctx, Recipe{UserID: other, Name: "C", Servings: 1, Source: SourceManual}, ings, []string{"secret"})
	require.NoError(t, err)
	t.Cleanup(func() {
		db.Exec("DELETE FROM recipes WHERE user_id IN (?,?)", owner, other)
	})

	counts, err := repo.TagCountsForUser(ctx, owner)
	require.NoError(t, err)
	require.Equal(t, []TagCount{{Tag: "vegetarian", Count: 2}, {Tag: "dinner", Count: 1}}, counts,
		"ordered by count desc then tag asc, and scoped to the owner")
}

// TestReplaceSwapsTags proves wholesale replacement, matching how ingredients
// already behave.
func TestReplaceSwapsTags(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()
	ings := []Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}}

	r, err := repo.Create(ctx, Recipe{UserID: owner, Name: "Old", Servings: 1, Source: SourceManual}, ings, []string{"a", "b"})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	require.NoError(t, repo.Replace(ctx, owner, r.ID, "New", 2, ings, []string{"c"}))

	byRecipe, err := repo.TagsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Equal(t, []string{"c"}, byRecipe[r.ID])
}

// TestStepsPersistInOrder proves steps come back in position order even when
// the rows are written or read in a different order — the sequence is the
// meaning.
func TestStepsPersistInOrder(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	steps := []string{"Rinse the lentils", "Fry the onion", "Simmer 25 minutes"}
	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Dal", Servings: 4, Source: SourcePaste},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "lentils", Grams: 200}},
		nil, steps,
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	byRecipe, err := repo.StepsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Equal(t, steps, byRecipe[r.ID], "order preserved exactly")
}

// TestStepsAllowDuplicates proves the (recipe_id, position) key, not a text
// key: "stir" twice in one method is legitimate and both must survive.
func TestStepsAllowDuplicates(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Stirry", Servings: 1, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}},
		nil, []string{"stir", "wait", "stir"},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	byRecipe, err := repo.StepsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Equal(t, []string{"stir", "wait", "stir"}, byRecipe[r.ID])
}

// TestReplaceSwapsSteps proves wholesale replacement and renumbering.
func TestReplaceSwapsSteps(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()
	ings := []Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}}

	r, err := repo.Create(ctx, Recipe{UserID: owner, Name: "Old", Servings: 1, Source: SourceManual}, ings, nil, []string{"a", "b", "c"})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	require.NoError(t, repo.Replace(ctx, owner, r.ID, "New", 1, ings, nil, []string{"z"}))

	byRecipe, err := repo.StepsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Equal(t, []string{"z"}, byRecipe[r.ID], "old steps gone, positions renumbered")
}

// TestTagsCascadeOnRecipeDelete proves the FK cascade.
func TestTagsCascadeOnRecipeDelete(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Gone", Servings: 1, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "x", Grams: 10}},
		[]string{"doomed"},
	)
	require.NoError(t, err)
	require.NoError(t, repo.DeleteForUser(ctx, owner, r.ID))

	var n int64
	require.NoError(t, db.Table("recipe_tags").Where("recipe_id = ?", r.ID).Count(&n).Error)
	require.Zero(t, n)

	require.NoError(t, db.Table("recipe_steps").Where("recipe_id = ?", r.ID).Count(&n).Error)
	require.Zero(t, n, "steps cascade too")
}
```

Every existing call to `repo.Create` and `repo.Replace` in this test file needs
the two new arguments — pass `nil, nil` where the test does not care about tags
or steps.

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestTags|TestListForUserFiltered|TestTagCounts|TestReplaceSwapsTags' -v`
Expected: FAIL to build — `Create` takes 2 args not 3, `undefined: TagCount`.

- [ ] **Step 3: Extend the repository**

In `api/internal/recipes/repository.go`:

Change `Create`'s signature to `func (r Repository) Create(ctx context.Context, rec Recipe, items []Ingredient, tags []string, steps []string) (Recipe, error)` and, inside its existing transaction after `insertIngredients`:

```go
		if err := insertTags(tx, rec.ID, tags); err != nil {
			return err
		}
		return insertSteps(tx, rec.ID, steps)
```

Change `Replace`'s signature to `func (r Repository) Replace(ctx context.Context, userID, recipeID uuid.UUID, name string, servings int, items []Ingredient, tags []string, steps []string) error` and, inside its transaction after `insertIngredients`, delete then reinsert both:

```go
		if err := tx.Where("recipe_id = ?", recipeID).Delete(&Tag{}).Error; err != nil {
			return err
		}
		if err := insertTags(tx, recipeID, tags); err != nil {
			return err
		}
		if err := tx.Where("recipe_id = ?", recipeID).Delete(&Step{}).Error; err != nil {
			return err
		}
		return insertSteps(tx, recipeID, steps)
```

Add these to the same file:

```go
// TagCount is one tag with how many of the caller's recipes carry it, used to
// order the filter chips by usefulness.
type TagCount struct {
	Tag   string
	Count int
}

// insertTags writes a recipe's tag set. The caller has already normalised and
// de-duplicated via normalizeTags, so this trusts the input; the table's
// composite primary key is the backstop.
func insertTags(tx *gorm.DB, recipeID uuid.UUID, tags []string) error {
	if len(tags) == 0 {
		return nil
	}
	rows := make([]Tag, len(tags))
	for i, t := range tags {
		rows[i] = Tag{RecipeID: recipeID, Tag: t}
	}
	return tx.Create(&rows).Error
}

// TagsForRecipes returns tags for the given recipes, alphabetical within each,
// so list and detail reads enrich without an N+1 query per recipe.
func (r Repository) TagsForRecipes(ctx context.Context, recipeIDs []uuid.UUID) (map[uuid.UUID][]string, error) {
	out := map[uuid.UUID][]string{}
	if len(recipeIDs) == 0 {
		return out, nil
	}
	var rows []Tag
	if err := r.db.WithContext(ctx).
		Where("recipe_id IN ?", recipeIDs).
		Order("recipe_id, tag").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("recipes: tags: %w", err)
	}
	for _, t := range rows {
		out[t.RecipeID] = append(out[t.RecipeID], t.Tag)
	}
	return out, nil
}

// insertSteps writes a recipe's method, assigning position from slice order so
// a caller can never desynchronise the two — the same rule insertIngredients
// follows.
func insertSteps(tx *gorm.DB, recipeID uuid.UUID, steps []string) error {
	if len(steps) == 0 {
		return nil
	}
	rows := make([]Step, len(steps))
	for i, s := range steps {
		rows[i] = Step{RecipeID: recipeID, Position: i, Text: s}
	}
	return tx.Create(&rows).Error
}

// StepsForRecipes returns each recipe's method in position order.
func (r Repository) StepsForRecipes(ctx context.Context, recipeIDs []uuid.UUID) (map[uuid.UUID][]string, error) {
	out := map[uuid.UUID][]string{}
	if len(recipeIDs) == 0 {
		return out, nil
	}
	var rows []Step
	if err := r.db.WithContext(ctx).
		Where("recipe_id IN ?", recipeIDs).
		Order("recipe_id, position").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("recipes: steps: %w", err)
	}
	for _, s := range rows {
		out[s.RecipeID] = append(out[s.RecipeID], s.Text)
	}
	return out, nil
}

// ListForUserFiltered lists the caller's recipes, optionally narrowed to those
// carrying EVERY supplied tag.
//
// AND, not OR: each chip a user taps should narrow the result. The HAVING
// COUNT(DISTINCT tag) = len(tags) form is what makes it AND — a plain IN would
// return recipes matching any single tag.
func (r Repository) ListForUserFiltered(ctx context.Context, userID uuid.UUID, tags []string) ([]Recipe, error) {
	if len(tags) == 0 {
		return r.ListForUser(ctx, userID)
	}
	out := []Recipe{}
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Where(`id IN (
			SELECT recipe_id FROM recipe_tags
			WHERE tag IN ?
			GROUP BY recipe_id
			HAVING COUNT(DISTINCT tag) = ?
		)`, tags, len(tags)).
		Order("created_at DESC").
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("recipes: list filtered: %w", err)
	}
	return out, nil
}

// TagCountsForUser returns the caller's distinct tags with recipe counts,
// most-used first so the filter chips lead with what is actually useful.
func (r Repository) TagCountsForUser(ctx context.Context, userID uuid.UUID) ([]TagCount, error) {
	out := []TagCount{}
	err := r.db.WithContext(ctx).
		Table("recipe_tags AS rt").
		Select("rt.tag AS tag, COUNT(*) AS count").
		Joins("JOIN recipes r ON r.id = rt.recipe_id").
		Where("r.user_id = ?", userID).
		Group("rt.tag").
		Order("count DESC, rt.tag ASC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("recipes: tag counts: %w", err)
	}
	return out, nil
}
```

- [ ] **Step 4: Fix the existing call sites**

`Create` and `Replace` are called from `api/internal/recipes/service.go`. Update both call sites to pass `nil, nil` for now so the package compiles — Task 3 threads the real values through. Run `grep -rn "repo.Create\|repo.Replace" internal/recipes/` to find every call site including tests, and update each to the new arity.

- [ ] **Step 5: Run to verify they pass**

Run from `api/`: `go build ./... && go test ./internal/recipes/ -count=1 -v 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: all PASS, including the pre-existing recipe tests.

- [ ] **Step 6: Commit**

```bash
git add api/internal/recipes/repository.go api/internal/recipes/repository_test.go api/internal/recipes/service.go
git commit -m "feat(recipes): persist and read recipe tags and steps, with AND tag filtering"
```

---

### Task 3: Service — thread tags and steps through save and read

**Files:**
- Modify: `api/internal/recipes/service.go`
- Test: `api/internal/recipes/service_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `RecipeView.Tags []string`, `RecipeView.Steps []string`, `SaveRecipeRequest.Tags []string`, `SaveRecipeRequest.Steps []string`, `(*Service) List(ctx, userID, tags []string) ([]RecipeView, error)` (note the new parameter), `(*Service) TagCounts(ctx, userID) ([]TagCount, error)`.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/recipes/service_test.go`:

```go
// TestCreateNormalisesAndDeduplicatesTags proves the service, not the caller,
// owns tag hygiene.
func TestCreateNormalisesAndDeduplicatesTags(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "lentils")},
		Tags:        []string{"Vegetarian", "vegetarian ", "DINNER", "!!!", ""},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	require.Equal(t, []string{"dinner", "vegetarian"}, v.Tags,
		"normalised, de-duplicated, alphabetical; junk dropped silently")

	read, err := svc.Get(ctx, userID, uuid.MustParse(v.ID))
	require.NoError(t, err)
	require.Equal(t, []string{"dinner", "vegetarian"}, read.Tags, "tags survive save -> read")
}

// TestCreateRejectsTooManyTags proves the cap is a validation error the
// handler maps to 400, not a silent truncation of the user's intent.
func TestCreateRejectsTooManyTags(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	tags := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}
	_, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Too many", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "x")},
		Tags:        tags,
	})
	_, ok := httpx.IsValidation(err)
	require.True(t, ok, "over the cap must be a validation error")
}

// TestListFiltersByTags proves the service passes the filter through.
func TestListFiltersByTags(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	_, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Veg dinner", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "x")},
		Tags:        []string{"vegetarian", "dinner"},
	})
	require.NoError(t, err)
	_, err = svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Veg lunch", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "x")},
		Tags:        []string{"vegetarian"},
	})
	require.NoError(t, err)

	got, err := svc.List(ctx, userID, []string{"vegetarian", "dinner"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "Veg dinner", got[0].Name)

	all, err := svc.List(ctx, userID, nil)
	require.NoError(t, err)
	require.Len(t, all, 2)
}

// TestStepsSurviveSaveAndRead proves the method round-trips in order.
func TestStepsSurviveSaveAndRead(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	steps := []string{"Rinse the lentils", "Fry the onion", "Simmer 25 minutes"}
	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourcePaste,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "lentils")},
		Steps:       append([]string{"  "}, steps...), // a blank step must be dropped
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, steps, v.Steps)

	read, err := svc.Get(ctx, userID, uuid.MustParse(v.ID))
	require.NoError(t, err)
	require.Equal(t, steps, read.Steps)
}

// TestStepsDoNotAffectMacros is the load-bearing test for the constraint that
// steps are purely descriptive: the same recipe with and without a method must
// produce byte-identical nutrition figures.
func TestStepsDoNotAffectMacros(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	base := SaveRecipeRequest{
		Name: "Plain", Servings: 2, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 200, "lentils")},
	}
	without, err := svc.Create(ctx, userID, base)
	require.NoError(t, err)

	withSteps := base
	withSteps.Name = "With method"
	withSteps.Steps = []string{"Add another 500g of everything", "Double it"}
	with, err := svc.Create(ctx, userID, withSteps)
	require.NoError(t, err)

	require.Equal(t, without.TotalKcal, with.TotalKcal)
	require.Equal(t, without.PerServingKcal, with.PerServingKcal)
	require.Equal(t, without.TotalProteinG, with.TotalProteinG)
}

// TestCreateRejectsTooManySteps proves the cap is a validation error.
func TestCreateRejectsTooManySteps(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	steps := make([]string, maxSteps+1)
	for i := range steps {
		steps[i] = "stir"
	}
	_, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Too long", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "x")},
		Steps:       steps,
	})
	_, ok := httpx.IsValidation(err)
	require.True(t, ok)
}

// TestTagCountsReturnsOwnerTags proves the chip source.
func TestTagCountsReturnsOwnerTags(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	_, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "A", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "x")},
		Tags:        []string{"vegetarian"},
	})
	require.NoError(t, err)

	counts, err := svc.TagCounts(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, []TagCount{{Tag: "vegetarian", Count: 1}}, counts)
}
```

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestCreateNormalises|TestCreateRejectsTooMany|TestListFilters|TestTagCounts' -v`
Expected: FAIL to build — `SaveRecipeRequest` has no `Tags`, `List` takes 2 args.

- [ ] **Step 3: Thread tags through the service**

In `api/internal/recipes/service.go`:

1. Add `Tags []string \`json:"tags"\`` and `Steps []string \`json:"steps"\`` to **both** `RecipeView` and `SaveRecipeRequest`.
2. In `validate`, after the existing checks, enforce both caps **before** normalisation, then normalise:

```go
	// Both caps are checked against what the CALLER supplied, before
	// normalisation collapses duplicates or drops blanks — otherwise sending
	// 40 variants of one tag would silently pass a limit meant to bound
	// intent, not storage.
	if len(req.Tags) > maxTags {
		return "", nil, nil, nil, nil, httpx.ValidationError{Message: fmt.Sprintf("a recipe can have at most %d tags", maxTags)}
	}
	if len(req.Steps) > maxSteps {
		return "", nil, nil, nil, nil, httpx.ValidationError{Message: fmt.Sprintf("a recipe can have at most %d steps", maxSteps)}
	}
	tags := normalizeTags(req.Tags)
	steps := normalizeSteps(req.Steps)
```

and return `tags` and `steps` as new fifth and sixth return values (update `validate`'s signature and both call sites in `Create` and `Update`).

3. `Create` passes `tags, steps` to `s.repo.Create(...)`; `Update` passes them to `s.repo.Replace(...)`.
4. Add `tags []string` and `steps []string` parameters to `viewFrom`, setting `v.Tags` and `v.Steps`. Do the same for `viewFromRows`, so the write path and the read path produce identical views — the #25 review specifically checked those two agree, and this is where they could silently diverge.
5. `List` gains a `tags []string` parameter, calls `s.repo.ListForUserFiltered(ctx, userID, normalizeTags(tags))`, and enriches each view from `s.repo.TagsForRecipes` **and** `s.repo.StepsForRecipes` (both batched over all returned ids — no N+1).
6. `Get` enriches from both, for the single recipe.
7. Add:

```go
// TagCounts returns the caller's tags with recipe counts, for the filter chips.
func (s *Service) TagCounts(ctx context.Context, userID uuid.UUID) ([]TagCount, error) {
	return s.repo.TagCountsForUser(ctx, userID)
}
```

- [ ] **Step 4: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -count=1 2>&1 | tail -3` — expect `ok`.

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/service.go api/internal/recipes/service_test.go
git commit -m "feat(recipes): thread tags and steps through save, read and list filtering"
```

---

### Task 4: AI tag and step extraction in the existing parse call

**Files:**
- Modify: `api/internal/recipes/parse.go`
- Test: `api/internal/recipes/parse_test.go`

**Interfaces:**
- Consumes: `normalizeTags`, `normalizeSteps`, `maxTags`, `maxSteps` from Task 1; `Draft` from the recipes feature.
- Produces: `Draft.Tags []string`, `Draft.Steps []string`.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/recipes/parse_test.go`:

```go
// TestParseTextSuggestsNormalisedTags proves model-supplied tags are
// normalised and capped before they reach the draft, so the model cannot
// inject junk into a user's tag set.
func TestParseTextSuggestsNormalisedTags(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{
		"name": "Dal", "servings": 4,
		"tags": ["Indian", "indian ", "VEGETARIAN", "!!!", ""],
		"ingredients": [{"text": "` + f.Name + `", "amount": 200, "unit": "g"}]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)
	require.Equal(t, []string{"indian", "vegetarian"}, d.Tags,
		"normalised, de-duplicated, alphabetical; junk dropped")
}

// TestParseTextExtractsSteps proves the method the parser previously threw
// away now reaches the draft, in order.
func TestParseTextExtractsSteps(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{
		"name": "Dal", "servings": 4,
		"steps": ["Rinse the lentils", "  ", "Simmer 25 minutes"],
		"ingredients": [{"text": "` + f.Name + `", "amount": 200, "unit": "g"}]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)
	require.Equal(t, []string{"Rinse the lentils", "Simmer 25 minutes"}, d.Steps,
		"order preserved, blank dropped")
}

// TestParseTextWithoutMetadataIsFine proves a model that returns neither tags
// nor steps yields a recipe with neither rather than an error.
func TestParseTextWithoutMetadataIsFine(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{
		"name": "Dal", "servings": 1,
		"ingredients": [{"text": "` + f.Name + `", "amount": 100, "unit": "g"}]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)
	require.Empty(t, d.Tags)
	require.Empty(t, d.Steps)
}

// TestParsePhotoHasNoSteps pins the deliberate asymmetry: Decompose returns
// ingredients only, and inventing a method from a guessed dish name would
// stack inference on inference.
func TestParsePhotoHasNoSteps(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "stew", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "150g", Confidence: 0.8}},
	}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.NoError(t, err)
	require.Empty(t, d.Steps, "a photo carries no method")
}
```

Note: `NewParser`'s third argument is the meter added during the #25 final review — check its exact type and the existing `stubMeter` in `parse_test.go` and match them.

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run TestParseText -v`
Expected: FAIL — `d.Tags` undefined.

- [ ] **Step 3: Add tags to the prompt, the decode target and the draft**

In `api/internal/recipes/parse.go`:

1. Add `Tags []string \`json:"tags"\`` and `Steps []string \`json:"steps"\`` to `Draft`.
2. Add the same two fields to the unexported `extracted` struct.
3. Extend `parseSystemPrompt`, appending to the JSON shape and adding two instruction sentences. The shape line becomes:

```go
	`{"name": string, "servings": integer, "tags": [string], "steps": [string], "ingredients": [{"text": string, "amount": number, "unit": string}]}. ` +
```

and add, before the existing "Do NOT state any calorie" sentence:

```go
	"\"tags\" is up to 5 short lowercase labels describing the dish's cuisine, " +
	"meal type and dietary character — for example \"indian\", \"dinner\", " +
	"\"vegetarian\", \"high-protein\". Omit any you are unsure of. " +
	"\"steps\" is the method, one instruction per entry, in order, copied as " +
	"written rather than reworded. Omit it entirely if the text contains no " +
	"method. " +
```

4. In `ParseText`, after building the draft, set `d.Tags = normalizeTags(ex.Tags)` and `d.Steps = normalizeSteps(ex.Steps)`.
5. In `ParsePhoto`, leave both empty — `Decompose` returns ingredients only, and inventing tags or a method from a dish name the model already guessed at would stack one inference on another. The user adds them in the review sheet.

Do **not** add a second provider call, and do **not** ask the model to summarise or improve the method. The whole justification for extracting this here is that it rides the existing request over text the user already chose.

- [ ] **Step 4: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -count=1 2>&1 | tail -3` — expect `ok`.
Then `go build ./... && go vet ./... && gofmt -l internal/recipes/` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/parse.go api/internal/recipes/parse_test.go
git commit -m "feat(recipes): extract tags and the method from the existing parse call"
```

---

### Task 5: HTTP — `?tags=` filter and the tag-list endpoint

**Files:**
- Modify: `api/internal/recipes/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/recipes/handler_test.go`
- Test: `api/internal/server/router_test.go`

**Interfaces:**
- Consumes: `(*Service) List(ctx, userID, tags)`, `(*Service) TagCounts(ctx, userID)` from Task 3.
- Produces: `Handler.Tags` method; `GET /v1/recipes` accepting `?tags=`; `GET /v1/recipes/tags`.

- [ ] **Step 1: Write the failing handler tests**

Append to `api/internal/recipes/handler_test.go`, following the gin test-context and auth-injection pattern already in that file:

```
TestListParsesTagsQuery          → ?tags=vegetarian,dinner reaches the service as two tags
TestListToleratesMalformedTags   → ?tags=,,vegetarian,, yields one tag, 200 not 400
TestTagsEndpointReturnsCounts    → GET /v1/recipes/tags returns the {data:[{tag,count}]} envelope
TestTagsEndpointRequiresAuth     → 401 with no user in context
```

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestList|TestTagsEndpoint' -v` — expect failures.

- [ ] **Step 3: Implement**

In `api/internal/recipes/handler.go`:

```go
// parseTagsQuery splits the ?tags= parameter. It is deliberately forgiving —
// empty segments and trailing commas are dropped rather than rejected. A
// filter is a read; refusing to answer because of a stray comma helps nobody.
func parseTagsQuery(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t, ok := normalizeTag(p); ok {
			out = append(out, t)
		}
	}
	return out
}
```

Change `Handler.List` to pass `parseTagsQuery(c.Query("tags"))` into `h.svc.List`, and add:

```go
func (h Handler) Tags(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	counts, err := h.svc.TagCounts(c.Request.Context(), userID)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, counts)
}
```

Give `TagCount` JSON tags so it serialises as `{"tag":…,"count":…}` — add `` `json:"tag"` `` and `` `json:"count"` `` to the struct in `repository.go`.

In `api/internal/server/router.go`, register **before** the `/v1/recipes/:id` route so the static path is obvious to the next reader:

```go
		v1.GET("/recipes/tags", recipeHandler.Tags)
```

- [ ] **Step 4: Add the route-registration assertion**

In `api/internal/server/router_test.go`, add `/v1/recipes/tags` to the existing recipe route list assertions (both the provider-present and provider-nil tests).

- [ ] **Step 5: Verify**

Run from `api/`: `go build ./... && go vet ./... && go test ./internal/recipes/ ./internal/server/ -count=1 2>&1 | tail -3` — expect `ok`.

- [ ] **Step 6: Commit**

```bash
git add api/internal/recipes/handler.go api/internal/recipes/handler_test.go api/internal/recipes/repository.go api/internal/server/router.go api/internal/server/router_test.go
git commit -m "feat(recipes): tag filter query and tag-list endpoint"
```

---

### Task 6: Mobile — types, hooks, and tag editing

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Modify: `apps/mobile/app/recipe/[id].tsx`
- Modify: `apps/mobile/src/components/recipes/RecipeParseSheet.tsx`
- Create: `apps/mobile/src/components/recipes/TagEditor.tsx`
- Create: `apps/mobile/src/components/recipes/MethodEditor.tsx`
- Test: `apps/mobile/src/api/__tests__/recipeTags.test.tsx`

**Interfaces:**
- Consumes: the endpoints from Task 5.
- Produces: `Recipe.tags`, `Recipe.steps`, `RecipeDraft.tags`, `RecipeDraft.steps`, `SaveRecipeBody.tags`, `SaveRecipeBody.steps`, `TagCount` type; `useRecipes(tags?: string[])`, `useRecipeTags()`; `<TagEditor value={} onChange={} suggestions={} />`; `<MethodEditor value={} onChange={} />`.

- [ ] **Step 1: Read the patterns first**

Read `apps/mobile/src/api/hooks.ts` around `useRecipes`, and `apps/mobile/AGENTS.md` (Expo has changed; it points at the versioned docs for this project). Match the existing query-key and invalidation conventions exactly.

- [ ] **Step 2: Add types**

In `apps/mobile/src/api/types.ts`: add `tags: string[]` and `steps: string[]` to `Recipe`, `tags?: string[]` and `steps?: string[]` to `RecipeDraft` and `SaveRecipeBody`, and:

```typescript
export interface TagCount {
  tag: string;
  count: number;
}
```

- [ ] **Step 3: Write the failing hook tests**

`apps/mobile/src/api/__tests__/recipeTags.test.tsx`, modelled on the existing `recipes.test.tsx` wrapper and `mockApiFetch` setup:

```
useRecipes() with no tags fetches /v1/recipes
useRecipes(["vegetarian","dinner"]) fetches /v1/recipes?tags=vegetarian%2Cdinner
useRecipes([]) fetches /v1/recipes with no query string
useRecipeTags fetches /v1/recipes/tags
useCreateRecipe sends tags in the body
```

- [ ] **Step 4: Run to verify they fail**

Run from `apps/mobile/`: `npx jest src/api/__tests__/recipeTags.test.tsx` — expect failures.

- [ ] **Step 5: Implement the hooks**

`useRecipes` gains an optional `tags?: string[]` argument. Its `queryKey` must include the tags (`["recipes", { tags }]`) or filtered and unfiltered results will collide in the cache — build the URL with `URLSearchParams` so the value is encoded. Add `useRecipeTags()` querying `["recipes", "tags"]` against `/v1/recipes/tags`.

Both `useCreateRecipe` and `useUpdateRecipe` already send the whole body, so they carry `tags` once the type allows it — but confirm their `onSuccess` invalidates `["recipes"]` broadly enough to refresh both the filtered list and the tag counts.

- [ ] **Step 6: Build the TagEditor component**

`apps/mobile/src/components/recipes/TagEditor.tsx`: chips with a remove affordance, a text input that adds on submit, and suggestions drawn from `useRecipeTags()`. It must refuse to add beyond 10 and show why, mirroring the server's cap rather than letting the save fail. Follow the styling of the existing chip treatments in `RecipeParseSheet.tsx`.

- [ ] **Step 7: Build the MethodEditor component**

`apps/mobile/src/components/recipes/MethodEditor.tsx`: a numbered list of steps, each editable in place, with add, remove and reorder (move up / move down is enough — no drag). It refuses to add beyond 40 and shows why. When the list is empty it renders a single "Add method" affordance rather than an empty numbered list, so a recipe without a method does not look broken.

Reorder must renumber visibly, because the number IS the meaning — a user must be able to see that step 2 became step 3.

- [ ] **Step 8: Wire both into both screens**

Use `<TagEditor>` and `<MethodEditor>` in `app/recipe/[id].tsx` (saving via `useUpdateRecipe` with the full body, exactly as the servings stepper and gram editing already do) and in `RecipeParseSheet.tsx` (editing the draft's suggested tags and extracted method before save). Every save path needs an `onError` toast.

On the detail screen the Method section goes **below** ingredients: macros and ingredients are what the app is for, the method is what the recipe is for, and the nutrition figures should not be pushed off-screen by a long method.

- [ ] **Step 9: Verify**

Run from `apps/mobile/`: `npx tsc --noEmit && npx jest` — expect clean and green. Add Jest coverage for the MethodEditor: add, edit, remove, reorder renumbering, the 40 cap, and the empty-state affordance.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/api/ apps/mobile/src/components/recipes/ apps/mobile/app/recipe/
git commit -m "feat(recipes): tag and method types, hooks and editors on both recipe surfaces"
```

---

### Task 7: Mobile — filter chips on the recipes list

**Files:**
- Modify: `apps/mobile/app/recipes.tsx`
- Test: `apps/mobile/app/__tests__/recipes.test.tsx`

**Interfaces:**
- Consumes: `useRecipes(tags)`, `useRecipeTags()` from Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/app/__tests__/recipes.test.tsx`:

```
the chip row renders the caller's tags, most-used first
tapping a chip filters the list
tapping a second chip narrows further (AND)
tapping an active chip clears it
the filtered-empty state differs from the no-recipes-yet state and offers to clear
```

- [ ] **Step 2: Run to verify they fail**

Run from `apps/mobile/`: `npx jest app/__tests__/recipes.test.tsx` — expect failures.

- [ ] **Step 3: Implement**

A horizontally scrolling chip row above the list, fed by `useRecipeTags()`, ordered by count as the server returns them. Selected tags live in local state and feed `useRecipes(selected)`. A clear affordance appears once anything is selected.

**The filtered-empty state must be distinct**: "No recipes match these tags" with a clear action, not the generic "No recipes yet — paste or photograph a recipe to reuse it", which would read as though the user's recipes had vanished.

Hide the chip row entirely when the user has no tags at all, so a new user sees no empty scaffolding.

- [ ] **Step 4: Verify**

Run from `apps/mobile/`: `npx tsc --noEmit && npx jest` — expect clean and green.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/recipes.tsx apps/mobile/app/__tests__/recipes.test.tsx
git commit -m "feat(recipes): filter recipes by tag chips"
```

---

### Task 8: Full verification and simulator check

- [ ] **Step 1: Backend**

Run from `api/`: `go build ./... && go vet ./... && gofmt -l internal/ && go test ./... -count=1`

Expected: clean, with only the two documented pre-existing failures (`internal/nutrition` embedding tests and one `internal/ai` search test, both caused by a seeded dev food index — confirmed identical on `main`).

- [ ] **Step 2: Mobile**

Run from `apps/mobile/`: `npx tsc --noEmit && npx jest`
Expected: clean and green.

- [ ] **Step 3: Start the API against the dev database**

```bash
cd api && set -a && . ./.env && set +a && go run ./cmd/api
```

**Verify it actually started**: confirm the log contains `"msg":"api listening"`. A stale process from an earlier run keeps port 8080 and will answer `/health`, making a failed restart look successful — `pkill -f "exe/api"` does NOT kill `go run`. Kill by PID from `lsof -i :8080 -sTCP:LISTEN` if the port is held.

- [ ] **Step 4: Drive it on the simulator**

Boot **iPhone 17 Pro** (not the Pro Max), `npx expo start --ios`. **Do not trigger an EAS build.**

Confirm:
1. Paste a recipe **with a method** → the review sheet shows suggested tags **and the extracted steps in order**.
2. Edit both — remove a tag, add a tag, edit a step, reorder two steps — then save.
3. The recipe detail shows the tags and a numbered Method section below the ingredients.
4. The per-serving macros are unchanged by the presence of a method.
5. The recipes list shows a chip row; tapping a chip filters.
6. Tapping a second chip narrows further.
7. A combination matching nothing shows the filtered-empty state, not "No recipes yet".

Use the Red Lentil Dal paste from the #25 handoff, which contains a real method
("Rinse the lentils… simmer covered for 25 minutes") — the same text whose
method the parser previously discarded.

- [ ] **Step 5: Record and commit**

Write what was verified, and anything that did not work, into `docs/superpowers/HANDOFF-2026-08-13-recipe-tags.md`, following the structure of the existing handoffs.

```bash
git add docs/superpowers/HANDOFF-2026-08-13-recipe-tags.md
git commit -m "docs: recipe tags handoff with simulator verification"
```
