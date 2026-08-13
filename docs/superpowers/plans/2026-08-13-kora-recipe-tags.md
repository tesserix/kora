# Recipe Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipes carry normalised, AI-suggested, user-editable tags, and the recipe list can be filtered by them.

**Architecture:** A `recipe_tags` join table keyed on `(recipe_id, tag)`, a pure `normalizeTag` in `internal/recipes`, tags threaded through the existing save/read/parse paths, and two read endpoints — a `?tags=` filter and a tag-list-with-counts. Mobile adds a filter-chip row and tag editing to the screens that already exist.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL, golang-migrate, testify. Expo/React Native, TypeScript, TanStack Query, Jest.

**Spec:** `docs/superpowers/specs/2026-08-13-kora-recipe-tags-design.md`

## Global Constraints

- **Do NOT reuse `nutrition.Normalize` for tags.** It singularises and strips punctuation for food-index matching, which would turn `high-protein` into `high protein` and `greens` into `green`. Tags get their own normaliser.
- **Max 10 tags per recipe**; a tag is capped at **30 characters** (truncate, don't reject); a tag normalising to empty is **dropped silently**, never a validation failure.
- Tags render and are returned **alphabetically**, always.
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

### Task 1: Migration `000030` + `normalizeTag`

**Files:**
- Create: `api/internal/database/migrations/000030_recipe_tags.up.sql`
- Create: `api/internal/database/migrations/000030_recipe_tags.down.sql`
- Create: `api/internal/recipes/tags.go`
- Test: `api/internal/recipes/tags_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `recipes.Tag` model, `normalizeTag(string) (string, bool)`, `normalizeTags([]string) []string`, constants `maxTags = 10`, `maxTagLen = 30`.

- [ ] **Step 1: Write the up migration**

`api/internal/database/migrations/000030_recipe_tags.up.sql`:

```sql
-- The composite primary key enforces per-recipe de-duplication in the database
-- rather than in application code, and needs no surrogate id. Tags are a SET,
-- not a sequence, so there is deliberately no position column.
CREATE TABLE recipe_tags (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);

-- Carries both the ?tags= filter and the tag-list-with-counts query.
CREATE INDEX ix_recipe_tags_tag ON recipe_tags (tag);
```

- [ ] **Step 2: Write the down migration**

`api/internal/database/migrations/000030_recipe_tags.down.sql`:

```sql
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

- [ ] **Step 7: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -run TestNormalize -v` — expect PASS.
Then `go build ./... && go vet ./... && gofmt -l internal/recipes/` — expect clean.

- [ ] **Step 8: Commit**

```bash
git add api/internal/database/migrations/000030_recipe_tags.up.sql api/internal/database/migrations/000030_recipe_tags.down.sql api/internal/recipes/tags.go api/internal/recipes/tags_test.go
git commit -m "feat(recipes): recipe_tags table and a tags-specific normaliser"
```

---

### Task 2: Repository — persist, read, filter, count

**Files:**
- Modify: `api/internal/recipes/repository.go`
- Test: `api/internal/recipes/repository_test.go`

**Interfaces:**
- Consumes: `Tag`, `normalizeTags` from Task 1; existing `Repository`, `Recipe`, `Ingredient`.
- Produces, all on `Repository`:
  - `TagsForRecipes(ctx, recipeIDs []uuid.UUID) (map[uuid.UUID][]string, error)`
  - `ListForUserFiltered(ctx, userID uuid.UUID, tags []string) ([]Recipe, error)` — empty `tags` behaves exactly like `ListForUser`
  - `TagCountsForUser(ctx, userID uuid.UUID) ([]TagCount, error)` with `type TagCount struct { Tag string; Count int }`
  - `Create` and `Replace` gain a `tags []string` parameter (see step 3 for exact signatures)

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
}
```

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestTags|TestListForUserFiltered|TestTagCounts|TestReplaceSwapsTags' -v`
Expected: FAIL to build — `Create` takes 2 args not 3, `undefined: TagCount`.

- [ ] **Step 3: Extend the repository**

In `api/internal/recipes/repository.go`:

Change `Create`'s signature to `func (r Repository) Create(ctx context.Context, rec Recipe, items []Ingredient, tags []string) (Recipe, error)` and, inside its existing transaction after `insertIngredients`, add `return insertTags(tx, rec.ID, tags)`.

Change `Replace`'s signature to `func (r Repository) Replace(ctx context.Context, userID, recipeID uuid.UUID, name string, servings int, items []Ingredient, tags []string) error` and, inside its transaction after `insertIngredients`, delete existing tags then insert the new set:

```go
		if err := tx.Where("recipe_id = ?", recipeID).Delete(&Tag{}).Error; err != nil {
			return err
		}
		return insertTags(tx, recipeID, tags)
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

`Create` and `Replace` are called from `api/internal/recipes/service.go`. Update both call sites to pass the recipe's normalised tags (Task 3 threads them through properly; for now pass `nil` so the package compiles, and Task 3 replaces that). Run `grep -n "repo.Create\|repo.Replace\|s.repo.Create\|s.repo.Replace" internal/recipes/*.go` to find them all, and update the existing repository tests from Task 2 of the recipes plan that call `Create`/`Replace` with the old arity.

- [ ] **Step 5: Run to verify they pass**

Run from `api/`: `go build ./... && go test ./internal/recipes/ -count=1 -v 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: all PASS, including the pre-existing recipe tests.

- [ ] **Step 6: Commit**

```bash
git add api/internal/recipes/repository.go api/internal/recipes/repository_test.go api/internal/recipes/service.go
git commit -m "feat(recipes): persist, read, AND-filter and count recipe tags"
```

---

### Task 3: Service — thread tags through save and read

**Files:**
- Modify: `api/internal/recipes/service.go`
- Test: `api/internal/recipes/service_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `RecipeView.Tags []string`, `SaveRecipeRequest.Tags []string`, `(*Service) List(ctx, userID, tags []string) ([]RecipeView, error)` (note the new parameter), `(*Service) TagCounts(ctx, userID) ([]TagCount, error)`.

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

1. Add `Tags []string \`json:"tags"\`` to `RecipeView`, and `Tags []string \`json:"tags"\`` to `SaveRecipeRequest`.
2. In `validate`, after the existing checks, normalise and enforce the cap **before** normalising truncates the count:

```go
	// The cap is checked against what the CALLER supplied, before
	// normalisation collapses duplicates — otherwise sending 40 variants of
	// one tag would silently pass a limit meant to bound intent, not storage.
	if len(req.Tags) > maxTags {
		return "", nil, nil, nil, httpx.ValidationError{Message: fmt.Sprintf("a recipe can have at most %d tags", maxTags)}
	}
	tags := normalizeTags(req.Tags)
```

and return `tags` as a new fifth return value (update `validate`'s signature and both call sites in `Create` and `Update`).

3. `Create` passes `tags` to `s.repo.Create(...)`; `Update` passes `tags` to `s.repo.Replace(...)`; both set `v.Tags = tags` on the returned view via `viewFrom`.
4. Add a `tags []string` parameter to `viewFrom` and set `v.Tags = tags`.
5. `List` gains a `tags []string` parameter, calls `s.repo.ListForUserFiltered(ctx, userID, normalizeTags(tags))`, and enriches each view from `s.repo.TagsForRecipes`.
6. `Get` enriches from `s.repo.TagsForRecipes(ctx, []uuid.UUID{rec.ID})`.
7. Add:

```go
// TagCounts returns the caller's tags with recipe counts, for the filter chips.
func (s *Service) TagCounts(ctx context.Context, userID uuid.UUID) ([]TagCount, error) {
	return s.repo.TagCountsForUser(ctx, userID)
}
```

Update `viewFromRows` to accept and set tags too, so the read and write paths produce identical views — the #25 review specifically checked that these two agree.

- [ ] **Step 4: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -count=1 2>&1 | tail -3` — expect `ok`.

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/service.go api/internal/recipes/service_test.go
git commit -m "feat(recipes): thread tags through save, read and list filtering"
```

---

### Task 4: AI tag suggestion in the existing parse call

**Files:**
- Modify: `api/internal/recipes/parse.go`
- Test: `api/internal/recipes/parse_test.go`

**Interfaces:**
- Consumes: `normalizeTags`, `maxTags` from Task 1; `Draft` from the recipes feature.
- Produces: `Draft.Tags []string`.

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

// TestParseTextWithoutTagsIsFine proves a model that returns no tags yields a
// recipe with none rather than an error.
func TestParseTextWithoutTagsIsFine(t *testing.T) {
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
}
```

Note: `NewParser`'s third argument is the meter added during the #25 final review — check its exact type and the existing `stubMeter` in `parse_test.go` and match them.

- [ ] **Step 2: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run TestParseText -v`
Expected: FAIL — `d.Tags` undefined.

- [ ] **Step 3: Add tags to the prompt, the decode target and the draft**

In `api/internal/recipes/parse.go`:

1. Add `Tags []string \`json:"tags"\`` to `Draft`.
2. Add `Tags []string \`json:"tags"\`` to the unexported `extracted` struct.
3. Extend `parseSystemPrompt`, appending to the JSON shape and adding one instruction sentence. The shape line becomes:

```go
	`{"name": string, "servings": integer, "tags": [string], "ingredients": [{"text": string, "amount": number, "unit": string}]}. ` +
```

and add, before the existing "Do NOT state any calorie" sentence:

```go
	"\"tags\" is up to 5 short lowercase labels describing the dish's cuisine, " +
	"meal type and dietary character — for example \"indian\", \"dinner\", " +
	"\"vegetarian\", \"high-protein\". Omit any you are unsure of. " +
```

4. In `ParseText`, after building the draft, set `d.Tags = normalizeTags(ex.Tags)`.
5. In `ParsePhoto`, leave `Tags` empty — `Decompose` returns ingredients only, and inventing tags from a dish name the model already guessed at would stack one inference on another. The user adds tags in the review sheet.

Do **not** add a second provider call. The whole justification for AI tagging is that it rides the existing request.

- [ ] **Step 4: Run to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -count=1 2>&1 | tail -3` — expect `ok`.
Then `go build ./... && go vet ./... && gofmt -l internal/recipes/` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/parse.go api/internal/recipes/parse_test.go
git commit -m "feat(recipes): suggest tags from the existing parse call, no extra request"
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
- Test: `apps/mobile/src/api/__tests__/recipeTags.test.tsx`

**Interfaces:**
- Consumes: the endpoints from Task 5.
- Produces: `Recipe.tags`, `RecipeDraft.tags`, `SaveRecipeBody.tags`, `TagCount` type; `useRecipes(tags?: string[])`, `useRecipeTags()`; `<TagEditor value={} onChange={} suggestions={} />`.

- [ ] **Step 1: Read the patterns first**

Read `apps/mobile/src/api/hooks.ts` around `useRecipes`, and `apps/mobile/AGENTS.md` (Expo has changed; it points at the versioned docs for this project). Match the existing query-key and invalidation conventions exactly.

- [ ] **Step 2: Add types**

In `apps/mobile/src/api/types.ts`: add `tags: string[]` to `Recipe`, `tags?: string[]` to `RecipeDraft` and `SaveRecipeBody`, and:

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

- [ ] **Step 7: Wire it into both screens**

Use `<TagEditor>` in `app/recipe/[id].tsx` (saving via `useUpdateRecipe` with the full body, exactly as the servings stepper and gram editing already do) and in `RecipeParseSheet.tsx` (editing the draft's suggested tags before save). Both need an `onError` toast.

- [ ] **Step 8: Verify**

Run from `apps/mobile/`: `npx tsc --noEmit && npx jest` — expect clean and green.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/api/ apps/mobile/src/components/recipes/TagEditor.tsx apps/mobile/app/recipe/ apps/mobile/src/components/recipes/RecipeParseSheet.tsx
git commit -m "feat(recipes): tag types, hooks and a tag editor on both recipe surfaces"
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
1. Paste a recipe → the review sheet shows suggested tags.
2. Edit them — remove one, add one — then save.
3. The recipe detail shows the tags.
4. The recipes list shows a chip row; tapping a chip filters.
5. Tapping a second chip narrows further.
6. A combination matching nothing shows the filtered-empty state, not "No recipes yet".

- [ ] **Step 5: Record and commit**

Write what was verified, and anything that did not work, into `docs/superpowers/HANDOFF-2026-08-13-recipe-tags.md`, following the structure of the existing handoffs.

```bash
git add docs/superpowers/HANDOFF-2026-08-13-recipe-tags.md
git commit -m "docs: recipe tags handoff with simulator verification"
```
