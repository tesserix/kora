# Recipes (#25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can build reusable recipes from pasted text or a photo, edit servings and ingredients with per-serving macros recomputing, and log any number of servings into the diary.

**Architecture:** A new Go package `api/internal/recipes` (model / repository / service / parse / log / handler) over migration `000028`, reusing `nutrition.Repository` for food rows, `units.ResolveEntered` for entered units, `ai.Provider` for extraction, and `foodlog.Service.CreateBatch` for the fan-out. Macros are never stored — always computed from live food rows. Mobile adds seven TanStack Query hooks, a list screen, a detail/editor screen, and a parse-review sheet.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL, golang-migrate, testify. Expo/React Native, TypeScript, TanStack Query, Jest.

**Spec:** `docs/superpowers/specs/2026-08-13-kora-recipes-design.md`

## Global Constraints

- Nutrition numbers come **only** from `nutrition.FoodItem` rows. The LLM supplies identity and portion phrases. Any macro number a model returns is discarded.
- No macro columns on any recipes table. Per-serving figures are computed on read.
- Timestamp columns use `gorm:"autoCreateTime"` / `gorm:"autoUpdateTime"`. A bare `time.Time` inserts Go's zero time and overrides `DEFAULT now()`.
- Entered units are resolved to grams **exactly once, server-side**, via `units.ResolveEntered`. The client never converts.
- All responses use the `{data}` envelope via `httpx.OK` / `httpx.Error`. Never raw `c.JSON`, except `c.JSON(http.StatusCreated, gin.H{"data": v})` for 201s, matching `savedmeals.Handler.Create`.
- A recipe belonging to another user is a **404**, never a 403.
- Go tests run against a real Postgres via the existing `testDB(t)` helper pattern (`t.Skipf` when unavailable). Only the AI provider is stubbed.
- Every mobile mutation surfaces errors through the toast path — never a silently disabled `isPending` button (issue #83).
- Commit after every task. Conventional commits, single-line, no signatures.

---

### Task 1: Migration `000028` + models

**Files:**
- Create: `api/internal/database/migrations/000028_recipes.up.sql`
- Create: `api/internal/database/migrations/000028_recipes.down.sql`
- Create: `api/internal/recipes/model.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `recipes.Recipe`, `recipes.Ingredient`, `recipes.IngredientRow`, and the source constants `recipes.SourceManual`, `recipes.SourcePaste`, `recipes.SourcePhoto`.

- [ ] **Step 1: Write the up migration**

`api/internal/database/migrations/000028_recipes.up.sql`:

```sql
CREATE TABLE recipes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    servings   INTEGER NOT NULL CHECK (servings > 0),
    source     TEXT NOT NULL CHECK (source IN ('manual','paste','photo')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_recipes_user ON recipes (user_id, created_at DESC);

-- food_item_id is NULLABLE on purpose: AI extraction regularly produces an
-- ingredient the food index cannot resolve. The recipe still saves, holding
-- that ingredient as raw_text with ZERO macro contribution, surfaced to the
-- user as needing attention. The two failure modes this rules out are
-- silently dropping the ingredient (macros quietly too low, user never told)
-- and fabricating a match (macros wrong, user actively misled).
CREATE TABLE recipe_ingredients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id       UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    food_item_id    UUID NULL REFERENCES food_items(id),
    raw_text        TEXT NOT NULL,
    grams           DOUBLE PRECISION NOT NULL DEFAULT 0,
    entered_amount  DOUBLE PRECISION NULL,
    entered_unit    TEXT NULL,
    -- portion_assumed carries #138's lesson: a guessed portion must stay
    -- LABELLED for the life of the row, not just on the confirm screen. A
    -- recipe is re-logged for months.
    portion_assumed BOOLEAN NOT NULL DEFAULT false,
    -- NULL match_score/match_tier means the USER picked this food, which
    -- carries no model confidence to record. Distinct from a low score.
    match_score     DOUBLE PRECISION NULL,
    match_tier      TEXT NULL
);

CREATE INDEX ix_recipe_ingredients_recipe ON recipe_ingredients (recipe_id, position);
```

- [ ] **Step 2: Write the down migration**

`api/internal/database/migrations/000028_recipes.down.sql`:

```sql
DROP TABLE IF EXISTS recipe_ingredients;
DROP TABLE IF EXISTS recipes;
```

- [ ] **Step 3: Apply the migration and verify**

Run from `api/`:

```bash
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" up
psql "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" -c "\d recipe_ingredients"
```

Expected: both tables listed, `food_item_id` shown as nullable, `servings` carrying the CHECK.

Then verify the down migration is reversible and re-apply:

```bash
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" down 1
migrate -path internal/database/migrations -database "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" up
```

- [ ] **Step 4: Write the models**

`api/internal/recipes/model.go`:

```go
// Package recipes owns user-authored, servings-aware dishes that can be
// logged repeatedly. A recipe differs from a saved meal: a saved meal is
// "log this exact plate again" (fixed grams), a recipe is "this dish yields
// N servings — log me 1.5 of them", and its ingredients may be unresolved
// raw text an AI extraction could not match to the food index.
package recipes

import (
	"time"

	"github.com/google/uuid"
)

// Recipe sources. A recipe records how it was created so the UI can explain
// why an ingredient carries model confidence.
const (
	SourceManual = "manual"
	SourcePaste  = "paste"
	SourcePhoto  = "photo"
)

type Recipe struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID   uuid.UUID `gorm:"type:uuid;not null;index"`
	Name     string    `gorm:"not null"`
	Servings int       `gorm:"not null"`
	Source   string    `gorm:"not null"`
	// autoCreateTime/autoUpdateTime are REQUIRED: a bare time.Time with no
	// tag inserts Go's zero time and overrides the SQL DEFAULT now(). This
	// cost an Important review finding on the groups package.
	CreatedAt time.Time `gorm:"autoCreateTime"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

func (Recipe) TableName() string { return "recipes" }

// Ingredient is one line of a recipe. FoodItemID is nil when the food index
// could not resolve RawText — the ingredient is kept, contributes no macros,
// and is reported to the user rather than dropped or guessed at.
type Ingredient struct {
	ID         uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	RecipeID   uuid.UUID  `gorm:"type:uuid;not null;index"`
	Position   int        `gorm:"not null"`
	FoodItemID *uuid.UUID `gorm:"type:uuid"`
	// RawText is kept even when resolution succeeds: it is what the user or
	// the model actually wrote, and what a later re-resolution needs. Same
	// rationale as food_logs.input_phrase living beside description.
	RawText       string   `gorm:"not null"`
	Grams         float64  `gorm:"not null;default:0"`
	EnteredAmount *float64 `gorm:"column:entered_amount"`
	EnteredUnit   *string  `gorm:"column:entered_unit"`
	// PortionAssumed reports that no serving size was known and the grams
	// below are a system estimate, not a measurement. It must survive save →
	// read → log; see issue #138 for what happens when it does not.
	PortionAssumed bool `gorm:"not null;default:false"`
	// MatchScore/MatchTier are nil when the user picked the food themselves
	// — no model confidence exists to record, which is different from low
	// confidence and is rendered differently.
	MatchScore *float64 `gorm:"column:match_score"`
	MatchTier  *string  `gorm:"column:match_tier"`
}

func (Ingredient) TableName() string { return "recipe_ingredients" }

// IngredientRow is a joined read of an ingredient with its food's name and
// per-100g macros, so list/detail reads enrich without an N+1 GetByID.
//
// The join behind this is a LEFT JOIN, unlike savedmeals.ItemsForMeals'
// INNER JOIN, because food_item_id is nullable here — an INNER JOIN would
// silently drop every unresolved ingredient, which is the exact silent
// shrinkage the nullable column exists to prevent. Name and the per-100g
// figures are therefore zero-valued for an unresolved row.
type IngredientRow struct {
	RecipeID       uuid.UUID
	FoodItemID     *uuid.UUID
	Position       int
	RawText        string
	Grams          float64
	EnteredAmount  *float64
	EnteredUnit    *string
	PortionAssumed bool
	MatchScore     *float64
	MatchTier      *string
	Name           string
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}
```

- [ ] **Step 5: Verify it compiles**

Run from `api/`: `go build ./...`
Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000028_recipes.up.sql api/internal/database/migrations/000028_recipes.down.sql api/internal/recipes/model.go
git commit -m "feat(recipes): migration 000028 and recipe models"
```

---

### Task 2: Repository

**Files:**
- Create: `api/internal/recipes/repository.go`
- Test: `api/internal/recipes/repository_test.go`

**Interfaces:**
- Consumes: `Recipe`, `Ingredient`, `IngredientRow` from Task 1.
- Produces:
  - `NewRepository(db *gorm.DB) Repository`
  - `(Repository) Create(ctx, Recipe, []Ingredient) (Recipe, error)`
  - `(Repository) ListForUser(ctx, userID uuid.UUID) ([]Recipe, error)`
  - `(Repository) GetForUser(ctx, userID, recipeID uuid.UUID) (Recipe, error)` — `gorm.ErrRecordNotFound` when absent or not owned
  - `(Repository) IngredientsForRecipes(ctx, recipeIDs []uuid.UUID) ([]IngredientRow, error)`
  - `(Repository) Replace(ctx, userID, recipeID uuid.UUID, name string, servings int, items []Ingredient) error`
  - `(Repository) DeleteForUser(ctx, userID, recipeID uuid.UUID) error`
  - `(Repository) CountForUser(ctx, userID uuid.UUID) (int64, error)`

- [ ] **Step 1: Write the failing tests**

`api/internal/recipes/repository_test.go`:

```go
package recipes

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "rc-"+id.String(), "rc@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedFood(t *testing.T, db *gorm.DB, kcal float64) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "RC Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: kcal, ProteinPer100g: 10,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestCreateGetScopedToOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Dal", Servings: 4, Source: SourcePaste},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "1 cup lentils", Grams: 200}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })
	require.False(t, r.CreatedAt.IsZero(), "autoCreateTime must populate created_at")

	got, err := repo.GetForUser(ctx, owner, r.ID)
	require.NoError(t, err)
	require.Equal(t, "Dal", got.Name)

	_, err = repo.GetForUser(ctx, other, r.ID)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound, "another user's recipe must be invisible")
}

// TestIngredientsForRecipesKeepsUnresolved is the whole point of the nullable
// food_item_id: a LEFT JOIN so an unresolved ingredient survives the read.
// An INNER JOIN here would silently shrink the recipe.
func TestIngredientsForRecipesKeepsUnresolved(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Curry", Servings: 2, Source: SourcePaste},
		[]Ingredient{
			{FoodItemID: &f.ID, RawText: "200g lentils", Grams: 200},
			{FoodItemID: nil, RawText: "a pinch of asafoetida", Grams: 0},
		},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	rows, err := repo.IngredientsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Len(t, rows, 2, "the unresolved ingredient must survive the join")
	require.Equal(t, 0, rows[0].Position)
	require.Equal(t, "200g lentils", rows[0].RawText)
	require.Nil(t, rows[1].FoodItemID)
	require.Equal(t, "a pinch of asafoetida", rows[1].RawText)
	require.Zero(t, rows[1].KcalPer100g, "unresolved rows carry no macros")
}

func TestReplaceSwapsIngredientsAtomically(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	f2 := seedFood(t, db, 200)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Old", Servings: 2, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f1.ID, RawText: "a", Grams: 100}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	require.NoError(t, repo.Replace(ctx, owner, r.ID, "New", 6,
		[]Ingredient{{FoodItemID: &f2.ID, RawText: "b", Grams: 50}}))

	got, err := repo.GetForUser(ctx, owner, r.ID)
	require.NoError(t, err)
	require.Equal(t, "New", got.Name)
	require.Equal(t, 6, got.Servings)

	rows, err := repo.IngredientsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "b", rows[0].RawText)

	require.ErrorIs(t, repo.Replace(ctx, other, r.ID, "Hijack", 1, nil), gorm.ErrRecordNotFound)
}

func TestDeleteScopedAndCascades(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Gone", Servings: 1, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "a", Grams: 10}},
	)
	require.NoError(t, err)

	require.ErrorIs(t, repo.DeleteForUser(ctx, other, r.ID), gorm.ErrRecordNotFound)
	require.NoError(t, repo.DeleteForUser(ctx, owner, r.ID))

	var n int64
	require.NoError(t, db.Table("recipe_ingredients").Where("recipe_id = ?", r.ID).Count(&n).Error)
	require.Zero(t, n, "ingredients must cascade with the recipe")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestCreateGetScopedToOwner|TestIngredientsForRecipesKeepsUnresolved|TestReplaceSwapsIngredientsAtomically|TestDeleteScopedAndCascades' -v`
Expected: FAIL to build — `undefined: NewRepository`.

- [ ] **Step 3: Write the repository**

`api/internal/recipes/repository.go`:

```go
package recipes

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Create inserts the recipe and its ingredients (with position) in one
// transaction.
func (r Repository) Create(ctx context.Context, rec Recipe, items []Ingredient) (Recipe, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&rec).Error; err != nil {
			return err
		}
		return insertIngredients(tx, rec.ID, items)
	})
	if err != nil {
		return Recipe{}, fmt.Errorf("recipes: create: %w", err)
	}
	return rec, nil
}

// insertIngredients rewrites Position from slice order, so callers never have
// to keep the two in sync.
func insertIngredients(tx *gorm.DB, recipeID uuid.UUID, items []Ingredient) error {
	if len(items) == 0 {
		return nil
	}
	rows := make([]Ingredient, len(items))
	for i, it := range items {
		rows[i] = Ingredient{
			RecipeID: recipeID, Position: i,
			FoodItemID: it.FoodItemID, RawText: it.RawText, Grams: it.Grams,
			EnteredAmount: it.EnteredAmount, EnteredUnit: it.EnteredUnit,
			PortionAssumed: it.PortionAssumed,
			MatchScore:     it.MatchScore, MatchTier: it.MatchTier,
		}
	}
	return tx.Create(&rows).Error
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]Recipe, error) {
	out := []Recipe{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("recipes: list: %w", err)
	}
	return out, nil
}

// GetForUser returns gorm.ErrRecordNotFound when the recipe is absent OR
// owned by someone else — the handler maps both to 404 so ids stay
// non-enumerable.
func (r Repository) GetForUser(ctx context.Context, userID, recipeID uuid.UUID) (Recipe, error) {
	var rec Recipe
	if err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", recipeID, userID).
		First(&rec).Error; err != nil {
		return Recipe{}, err
	}
	return rec, nil
}

// IngredientsForRecipes returns ingredients joined to food_items for name and
// per-100g macros, ordered by (recipe, position).
//
// LEFT JOIN, deliberately — food_item_id is nullable, and an INNER JOIN would
// silently drop every unresolved ingredient from the result, shrinking the
// recipe with no error and no indication to the user. That is precisely the
// silent shrinkage the nullable column exists to prevent.
//
// Like savedmeals.ItemsForMeals, this does NOT filter fi.deleted_at: a user
// must still see the recipe they saved, name and macros intact, after the
// underlying food is retired from the index. The batch log path rejects a
// retired item separately (foodlog.Service.CreateBatch).
func (r Repository) IngredientsForRecipes(ctx context.Context, recipeIDs []uuid.UUID) ([]IngredientRow, error) {
	out := []IngredientRow{}
	if len(recipeIDs) == 0 {
		return out, nil
	}
	err := r.db.WithContext(ctx).
		Table("recipe_ingredients AS ri").
		Select("ri.recipe_id, ri.food_item_id, ri.position, ri.raw_text, ri.grams, " +
			"ri.entered_amount, ri.entered_unit, ri.portion_assumed, ri.match_score, ri.match_tier, " +
			"COALESCE(fi.name, '') AS name, " +
			"COALESCE(fi.kcal_per_100g, 0) AS kcal_per100g, " +
			"COALESCE(fi.protein_per_100g, 0) AS protein_per100g, " +
			"COALESCE(fi.carbs_per_100g, 0) AS carbs_per100g, " +
			"COALESCE(fi.fat_per_100g, 0) AS fat_per100g, " +
			"COALESCE(fi.fiber_per_100g, 0) AS fiber_per100g").
		Joins("LEFT JOIN food_items fi ON fi.id = ri.food_item_id").
		Where("ri.recipe_id IN ?", recipeIDs).
		Order("ri.recipe_id, ri.position").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("recipes: ingredients: %w", err)
	}
	return out, nil
}

// Replace updates a user-owned recipe's name/servings and swaps its
// ingredients atomically.
func (r Repository) Replace(ctx context.Context, userID, recipeID uuid.UUID, name string, servings int, items []Ingredient) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing Recipe
		if err := tx.Where("id = ? AND user_id = ?", recipeID, userID).First(&existing).Error; err != nil {
			return err // gorm.ErrRecordNotFound if absent/not owned
		}
		if err := tx.Model(&Recipe{}).Where("id = ?", recipeID).
			Updates(map[string]any{"name": name, "servings": servings, "updated_at": gorm.Expr("now()")}).Error; err != nil {
			return err
		}
		if err := tx.Where("recipe_id = ?", recipeID).Delete(&Ingredient{}).Error; err != nil {
			return err
		}
		return insertIngredients(tx, recipeID, items)
	})
	if err != nil {
		return fmt.Errorf("recipes: replace: %w", err)
	}
	return nil
}

func (r Repository) DeleteForUser(ctx context.Context, userID, recipeID uuid.UUID) error {
	res := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", recipeID, userID).Delete(&Recipe{})
	if res.Error != nil {
		return fmt.Errorf("recipes: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("recipes: delete: %w", gorm.ErrRecordNotFound)
	}
	return nil
}

func (r Repository) CountForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&Recipe{}).Where("user_id = ?", userID).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("recipes: count: %w", err)
	}
	return n, nil
}
```

Note on `Replace`: an earlier draft of this plan set `updated_at` explicitly with `gorm.Expr("now()")`, on the belief that a map-based `Updates` bypasses GORM's `autoUpdateTime` hook. **That is false on gorm v1.31.2** — verified during Task 2 by removing the explicit entry and confirming `TestReplaceAdvancesUpdatedAt` still passes. Do not add it: the `autoUpdateTime` tag on `Recipe.UpdatedAt` covers the map-update path, and the explicit entry is redundant with a misleading comment attached. The test guards the real property either way.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -v`
Expected: PASS (4 tests). If Postgres is not running, the tests skip — start it with `docker compose up -d` from the repo root and re-run; they must actually pass, not skip.

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/repository.go api/internal/recipes/repository_test.go
git commit -m "feat(recipes): repository with owner-scoped reads and left-joined ingredients"
```

---

### Task 3: Service — CRUD, validation, macro computation

**Files:**
- Create: `api/internal/recipes/service.go`
- Test: `api/internal/recipes/service_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `NewService(repo Repository, foods nutrition.Repository) *Service`
  - View types `IngredientView`, `RecipeView`
  - Request types `IngredientInput`, `SaveRecipeRequest`
  - `(*Service) List(ctx, userID) ([]RecipeView, error)`
  - `(*Service) Get(ctx, userID, recipeID) (RecipeView, error)`
  - `(*Service) Create(ctx, userID, SaveRecipeRequest) (RecipeView, error)`
  - `(*Service) Update(ctx, userID, recipeID, SaveRecipeRequest) (RecipeView, error)`
  - `(*Service) Delete(ctx, userID, recipeID) error`

- [ ] **Step 1: Write the failing tests**

`api/internal/recipes/service_test.go`:

```go
package recipes

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func ing(foodID string, grams float64, raw string) IngredientInput {
	return IngredientInput{FoodItemID: &foodID, Grams: grams, RawText: raw}
}

// TestPerServingMacrosDivideByServings is the core arithmetic: totals come
// from live food rows, per-serving divides by the yield.
func TestPerServingMacrosDivideByServings(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100) // 100 kcal/100g, 10 protein/100g
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "  Dal  ", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	require.Equal(t, "Dal", v.Name) // trimmed
	require.Equal(t, 400.0, v.TotalKcal)     // 100/100 * 400
	require.Equal(t, 100.0, v.PerServingKcal) // 400 / 4
	require.Equal(t, 10.0, v.PerServingProteinG)
	require.Zero(t, v.UnresolvedCount)
}

// TestUnresolvedIngredientContributesZeroAndIsCounted proves an unresolved
// ingredient is neither dropped nor guessed at.
func TestUnresolvedIngredientContributesZeroAndIsCounted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	v, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Curry", Servings: 2, Source: SourcePaste,
		Ingredients: []IngredientInput{
			ing(f.ID.String(), 200, "200g lentils"),
			{FoodItemID: nil, RawText: "a pinch of asafoetida"},
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	require.Len(t, v.Ingredients, 2)
	require.Equal(t, 200.0, v.TotalKcal) // the unresolved line adds nothing
	require.Equal(t, 1, v.UnresolvedCount)
	require.False(t, v.Ingredients[1].Resolved)
	require.Equal(t, "a pinch of asafoetida", v.Ingredients[1].RawText)
}

// TestUpdateServingsRecomputesWithoutTouchingIngredients is #25's stated
// acceptance criterion.
func TestUpdateServingsRecomputesWithoutTouchingIngredients(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 100.0, created.PerServingKcal)

	id := uuid.MustParse(created.ID)
	updated, err := svc.Update(ctx, userID, id, SaveRecipeRequest{
		Name: "Dal", Servings: 8, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)
	require.Equal(t, 400.0, updated.TotalKcal)
	require.Equal(t, 50.0, updated.PerServingKcal) // 400 / 8
}

// TestPortionAssumedSurvivesSaveAndRead is issue #138's lesson applied: a
// guessed portion must stay labelled after the confirm screen is gone.
func TestPortionAssumedSurvivesSaveAndRead(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	fid := f.ID.String()
	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Guessy", Servings: 1, Source: SourcePhoto,
		Ingredients: []IngredientInput{{
			FoodItemID: &fid, Grams: 150, RawText: "some lentils", PortionAssumed: true,
		}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.True(t, created.Ingredients[0].PortionAssumed)

	read, err := svc.Get(ctx, userID, uuid.MustParse(created.ID))
	require.NoError(t, err)
	require.True(t, read.Ingredients[0].PortionAssumed, "assumed portion must survive the round trip")
}

// TestCreateResolvesEnteredUnitsServerSide mirrors the saved-meal and
// food-log surfaces: the client never converts.
func TestCreateResolvesEnteredUnitsServerSide(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	sachet := nutrition.FoodItem{
		Name: "RC Sachet " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  100,
	}
	require.NoError(t, db.Create(&sachet).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", sachet.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	amount, unit := 2.0, "sachet"
	fid := sachet.ID.String()
	v, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Mocha", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{{
			FoodItemID: &fid, Grams: 0, RawText: "2 sachets",
			EnteredAmount: &amount, EnteredUnit: &unit,
		}},
	})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })
	require.Equal(t, 33.0, v.Ingredients[0].Grams) // 2 * 16.5, resolved server-side
	require.Equal(t, 33.0, v.TotalKcal)            // 100/100 * 33
}

func TestCreateValidates(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()

	bad := func(req SaveRecipeRequest) {
		t.Helper()
		_, err := svc.Create(ctx, userID, req)
		_, ok := httpx.IsValidation(err)
		require.True(t, ok, "expected a validation error")
	}

	bad(SaveRecipeRequest{Name: "", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 0, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: "scanned",
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual})
	unknown := uuid.NewString()
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(unknown, 100, "a")}})
	bad(SaveRecipeRequest{Name: "x", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{{FoodItemID: nil, RawText: ""}}})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run 'TestPerServing|TestUnresolved|TestUpdateServings|TestPortionAssumed|TestCreateResolves|TestCreateValidates' -v`
Expected: FAIL to build — `undefined: NewService`.

- [ ] **Step 3: Write the service**

`api/internal/recipes/service.go`:

```go
package recipes

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

const (
	maxRecipes     = 100
	maxNameLen     = 120
	maxRawTextLen  = 200
	maxIngredients = 60
	maxServings    = 100
)

var validSources = map[string]bool{SourceManual: true, SourcePaste: true, SourcePhoto: true}

// IngredientView is one rendered ingredient. Resolved == false means the food
// index has no match for RawText: the line is shown, contributes no macros,
// and is counted in RecipeView.UnresolvedCount.
type IngredientView struct {
	FoodItemID     *string  `json:"food_item_id"`
	Name           string   `json:"name"`
	RawText        string   `json:"raw_text"`
	Resolved       bool     `json:"resolved"`
	Grams          float64  `json:"grams"`
	EnteredAmount  *float64 `json:"entered_amount"`
	EnteredUnit    *string  `json:"entered_unit"`
	PortionAssumed bool     `json:"portion_assumed"`
	MatchScore     *float64 `json:"match_score"`
	MatchTier      *string  `json:"match_tier"`
	Kcal           float64  `json:"kcal"`
	ProteinG       float64  `json:"protein_g"`
	CarbsG         float64  `json:"carbs_g"`
	FatG           float64  `json:"fat_g"`
	FiberG         float64  `json:"fiber_g"`
}

// RecipeView carries BOTH totals and per-serving figures. Neither is stored:
// both are computed from live food rows on every read, so a correction to the
// food index shows up immediately instead of leaving a stale copy behind.
type RecipeView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Servings int    `json:"servings"`
	Source   string `json:"source"`

	Ingredients []IngredientView `json:"ingredients"`
	// UnresolvedCount lets the client say the total is PARTIAL rather than
	// implying completeness.
	UnresolvedCount int `json:"unresolved_count"`

	TotalKcal     float64 `json:"total_kcal"`
	TotalProteinG float64 `json:"total_protein_g"`
	TotalCarbsG   float64 `json:"total_carbs_g"`
	TotalFatG     float64 `json:"total_fat_g"`
	TotalFiberG   float64 `json:"total_fiber_g"`

	PerServingKcal     float64 `json:"per_serving_kcal"`
	PerServingProteinG float64 `json:"per_serving_protein_g"`
	PerServingCarbsG   float64 `json:"per_serving_carbs_g"`
	PerServingFatG     float64 `json:"per_serving_fat_g"`
	PerServingFiberG   float64 `json:"per_serving_fiber_g"`
}

// IngredientInput is one ingredient as submitted. FoodItemID nil means the
// user is deliberately keeping an unresolved line.
type IngredientInput struct {
	FoodItemID *string `json:"food_item_id"`
	RawText    string  `json:"raw_text"`
	Grams      float64 `json:"grams"`
	// EnteredAmount/EnteredUnit carry what was actually typed ("2 sachets").
	// When both are set the SERVER resolves them into Grams exactly once —
	// the client never converts, and the resolved grams drive every figure.
	EnteredAmount  *float64 `json:"entered_amount"`
	EnteredUnit    *string  `json:"entered_unit"`
	PortionAssumed bool     `json:"portion_assumed"`
	MatchScore     *float64 `json:"match_score"`
	MatchTier      *string  `json:"match_tier"`
}

type SaveRecipeRequest struct {
	Name        string            `json:"name"`
	Servings    int               `json:"servings"`
	Source      string            `json:"source"`
	Ingredients []IngredientInput `json:"ingredients"`
}

type Service struct {
	repo  Repository
	foods nutrition.Repository
}

func NewService(repo Repository, foods nutrition.Repository) *Service {
	return &Service{repo: repo, foods: foods}
}

// resolveEnteredUnit resolves an entered (amount, unit) pair into grams
// against food, exactly once — mirroring savedmeals.resolveEnteredUnit and
// foodlog.resolveEnteredUnit so all three surfaces convert identically and
// report the same message.
func resolveEnteredUnit(amount float64, unit string, food nutrition.FoodItem) (float64, error) {
	grams, err := units.ResolveEntered(amount, unit, food.BaseUnit, food.ServingUnits)
	if err != nil {
		return 0, httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
	}
	return grams, nil
}

// validate checks the request and resolves each ingredient's food, returning
// the rows to persist and the enriched views to respond with.
func (s *Service) validate(ctx context.Context, req SaveRecipeRequest) (string, []Ingredient, []IngredientView, error) {
	name := strings.TrimSpace(req.Name)
	switch {
	case name == "":
		return "", nil, nil, httpx.ValidationError{Message: "name is required"}
	case len(name) > maxNameLen:
		return "", nil, nil, httpx.ValidationError{Message: "name is too long"}
	case req.Servings < 1:
		return "", nil, nil, httpx.ValidationError{Message: "servings must be at least 1"}
	case req.Servings > maxServings:
		return "", nil, nil, httpx.ValidationError{Message: "servings is too large"}
	case !validSources[req.Source]:
		return "", nil, nil, httpx.ValidationError{Message: "invalid source"}
	case len(req.Ingredients) == 0:
		return "", nil, nil, httpx.ValidationError{Message: "at least one ingredient is required"}
	case len(req.Ingredients) > maxIngredients:
		return "", nil, nil, httpx.ValidationError{Message: "too many ingredients"}
	}

	items := make([]Ingredient, 0, len(req.Ingredients))
	views := make([]IngredientView, 0, len(req.Ingredients))
	for _, in := range req.Ingredients {
		raw := strings.TrimSpace(in.RawText)
		if raw == "" {
			return "", nil, nil, httpx.ValidationError{Message: "each ingredient needs a description"}
		}
		if len(raw) > maxRawTextLen {
			return "", nil, nil, httpx.ValidationError{Message: "ingredient description is too long"}
		}

		// An UNRESOLVED ingredient is a first-class, valid state: it is kept
		// verbatim, contributes nothing, and is reported. Dropping it would
		// understate the recipe silently; guessing a food would misstate it.
		if in.FoodItemID == nil {
			items = append(items, Ingredient{RawText: raw})
			views = append(views, IngredientView{RawText: raw, Resolved: false})
			continue
		}

		fid, err := uuid.Parse(*in.FoodItemID)
		if err != nil {
			return "", nil, nil, httpx.ValidationError{Message: "invalid food_item_id"}
		}
		food, err := s.foods.GetByID(ctx, fid)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return "", nil, nil, httpx.ValidationError{Message: "unknown food_item_id"}
			}
			return "", nil, nil, fmt.Errorf("recipes: resolve food: %w", err)
		}

		grams := in.Grams
		if in.EnteredAmount != nil && in.EnteredUnit != nil {
			grams, err = resolveEnteredUnit(*in.EnteredAmount, *in.EnteredUnit, food)
			if err != nil {
				return "", nil, nil, err
			}
		}
		if grams <= 0 {
			return "", nil, nil, httpx.ValidationError{Message: "grams must be positive"}
		}

		items = append(items, Ingredient{
			FoodItemID: &fid, RawText: raw, Grams: grams,
			EnteredAmount: in.EnteredAmount, EnteredUnit: in.EnteredUnit,
			PortionAssumed: in.PortionAssumed,
			MatchScore:     in.MatchScore, MatchTier: in.MatchTier,
		})
		idStr := fid.String()
		f := grams / 100.0
		views = append(views, IngredientView{
			FoodItemID: &idStr, Name: food.Name, RawText: raw, Resolved: true, Grams: grams,
			EnteredAmount: in.EnteredAmount, EnteredUnit: in.EnteredUnit,
			PortionAssumed: in.PortionAssumed,
			MatchScore:     in.MatchScore, MatchTier: in.MatchTier,
			Kcal:     food.KcalPer100g * f,
			ProteinG: food.ProteinPer100g * f,
			CarbsG:   food.CarbsPer100g * f,
			FatG:     food.FatPer100g * f,
			FiberG:   food.FiberPer100g * f,
		})
	}
	return name, items, views, nil
}

// viewFrom sums the ingredient views into totals and divides by servings.
// This is the ONLY place per-serving figures are produced.
func viewFrom(id, name, source string, servings int, ivs []IngredientView) RecipeView {
	v := RecipeView{ID: id, Name: name, Servings: servings, Source: source, Ingredients: ivs}
	for _, iv := range ivs {
		if !iv.Resolved {
			v.UnresolvedCount++
			continue
		}
		v.TotalKcal += iv.Kcal
		v.TotalProteinG += iv.ProteinG
		v.TotalCarbsG += iv.CarbsG
		v.TotalFatG += iv.FatG
		v.TotalFiberG += iv.FiberG
	}
	if servings > 0 {
		d := float64(servings)
		v.PerServingKcal = v.TotalKcal / d
		v.PerServingProteinG = v.TotalProteinG / d
		v.PerServingCarbsG = v.TotalCarbsG / d
		v.PerServingFatG = v.TotalFatG / d
		v.PerServingFiberG = v.TotalFiberG / d
	}
	return v
}

// viewFromRows builds a view from persisted joined rows (the read path).
func viewFromRows(rec Recipe, rows []IngredientRow) RecipeView {
	ivs := make([]IngredientView, 0, len(rows))
	for _, r := range rows {
		iv := IngredientView{
			RawText: r.RawText, Grams: r.Grams,
			EnteredAmount: r.EnteredAmount, EnteredUnit: r.EnteredUnit,
			PortionAssumed: r.PortionAssumed,
			MatchScore:     r.MatchScore, MatchTier: r.MatchTier,
			Resolved: r.FoodItemID != nil,
		}
		if r.FoodItemID != nil {
			id := r.FoodItemID.String()
			iv.FoodItemID = &id
			iv.Name = r.Name
			f := r.Grams / 100.0
			iv.Kcal = r.KcalPer100g * f
			iv.ProteinG = r.ProteinPer100g * f
			iv.CarbsG = r.CarbsPer100g * f
			iv.FatG = r.FatPer100g * f
			iv.FiberG = r.FiberPer100g * f
		}
		ivs = append(ivs, iv)
	}
	return viewFrom(rec.ID.String(), rec.Name, rec.Source, rec.Servings, ivs)
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]RecipeView, error) {
	recs, err := s.repo.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 {
		return []RecipeView{}, nil
	}
	ids := make([]uuid.UUID, len(recs))
	for i, r := range recs {
		ids[i] = r.ID
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, ids)
	if err != nil {
		return nil, err
	}
	byRecipe := map[uuid.UUID][]IngredientRow{}
	for _, r := range rows {
		byRecipe[r.RecipeID] = append(byRecipe[r.RecipeID], r)
	}
	out := make([]RecipeView, 0, len(recs))
	for _, rec := range recs {
		out = append(out, viewFromRows(rec, byRecipe[rec.ID]))
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, userID, recipeID uuid.UUID) (RecipeView, error) {
	rec, err := s.repo.GetForUser(ctx, userID, recipeID)
	if err != nil {
		return RecipeView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, []uuid.UUID{rec.ID})
	if err != nil {
		return RecipeView{}, err
	}
	return viewFromRows(rec, rows), nil
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, req SaveRecipeRequest) (RecipeView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return RecipeView{}, err
	}
	count, err := s.repo.CountForUser(ctx, userID)
	if err != nil {
		return RecipeView{}, err
	}
	if count >= maxRecipes {
		return RecipeView{}, httpx.ValidationError{Message: "recipe limit reached"}
	}
	rec, err := s.repo.Create(ctx, Recipe{
		UserID: userID, Name: name, Servings: req.Servings, Source: req.Source,
	}, items)
	if err != nil {
		return RecipeView{}, err
	}
	return viewFrom(rec.ID.String(), name, req.Source, req.Servings, views), nil
}

func (s *Service) Update(ctx context.Context, userID, recipeID uuid.UUID, req SaveRecipeRequest) (RecipeView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return RecipeView{}, err
	}
	if err := s.repo.Replace(ctx, userID, recipeID, name, req.Servings, items); err != nil {
		return RecipeView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	return viewFrom(recipeID.String(), name, req.Source, req.Servings, views), nil
}

func (s *Service) Delete(ctx context.Context, userID, recipeID uuid.UUID) error {
	return s.repo.DeleteForUser(ctx, userID, recipeID)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/recipes/ -v`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add api/internal/recipes/service.go api/internal/recipes/service_test.go
git commit -m "feat(recipes): service with computed per-serving macros and unresolved-ingredient handling"
```

---

### Task 4: AI parse — paste and photo → unsaved draft

**Files:**
- Create: `api/internal/recipes/parse.go`
- Test: `api/internal/recipes/parse_test.go`

**Interfaces:**
- Consumes: `IngredientInput` and the service from Task 3; `ai.Provider`, `ai.Guess`, `ai.IngredientGuess`, `ai.Usage`, `ai.OutcomeOK`, `ai.OutcomeError`; `nutrition.Repository.Resolve`.
- Produces:
  - `type Parser struct` with `NewParser(p ai.Provider, foods nutrition.Repository) *Parser`
  - `(*Parser) ParseText(ctx, userID uuid.UUID, text string) (Draft, error)`
  - `(*Parser) ParsePhoto(ctx, userID uuid.UUID, image []byte, mime string) (Draft, error)`
  - `type Draft struct { Name string; Servings int; Source string; Ingredients []IngredientInput }`
  - `var ErrParseFailed = errors.New("recipes: could not parse")`

**Design notes the implementer must honour:**

- **No new method on `ai.Provider`.** Adding one means implementing it in the Gemini provider, the OpenAI provider, `ai.Router`, and every test fake. Paste uses the existing `GenerateText`; photo uses the existing `IdentifyPhoto` + `Decompose`.
- **Paste** asks `GenerateText` for strict JSON and validates it here. `GenerateText` does not enforce a schema (see its doc comment), so unparseable output is a **parse failure**, never a partial success.
- **Photo** cannot extract a reliable name or yield, so it defaults `Servings: 1` and names the recipe after the strongest `Guess`. The user fixes both in the review sheet. This is honest rather than invented.
- **The parser persists nothing.** An abandoned parse leaves no rows.
- **Nutrition never comes from the model.** The prompt does not request macros; any the model volunteers are discarded.

- [ ] **Step 1: Write the failing tests**

`api/internal/recipes/parse_test.go`:

```go
package recipes

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// stubProvider implements ai.Provider. Only the three methods the parser uses
// are meaningful; the rest exist to satisfy the interface.
type stubProvider struct {
	generated   string
	generateErr error
	guesses     []ai.Guess
	photoErr    error
	ingredients []ai.IngredientGuess
	decomposeErr error
}

func (s *stubProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return s.guesses, ai.Usage{}, s.photoErr
}
func (s *stubProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return s.ingredients, ai.Usage{}, s.decomposeErr
}
func (s *stubProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (s *stubProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return s.generated, ai.Usage{}, s.generateErr
}
func (s *stubProvider) Name() string { return "stub" }

func TestParseTextExtractsNameServingsAndIngredients(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{generated: `{
		"name": "Masoor Dal",
		"servings": 4,
		"ingredients": [
			{"text": "` + f.Name + `", "amount": 200, "unit": "g"},
			{"text": "asafoetida", "amount": 1, "unit": "pinch"}
		]
	}`}, nutrition.NewRepository(db))

	d, err := p.ParseText(context.Background(), userID, "…pasted recipe…")
	require.NoError(t, err)
	require.Equal(t, "Masoor Dal", d.Name)
	require.Equal(t, 4, d.Servings)
	require.Equal(t, SourcePaste, d.Source)
	require.Len(t, d.Ingredients, 2)
	require.NotNil(t, d.Ingredients[0].FoodItemID, "a seeded food must resolve")
	require.Equal(t, f.ID.String(), *d.Ingredients[0].FoodItemID)
	require.Nil(t, d.Ingredients[1].FoodItemID, "an unmatchable ingredient stays unresolved, not guessed")
	require.Equal(t, "asafoetida", d.Ingredients[1].RawText)
}

// TestParseTextRejectsNonJSON: GenerateText enforces no schema, so garbage is
// a parse failure the caller turns into "enter it manually" — never a
// half-built recipe.
func TestParseTextRejectsNonJSON(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generated: "Sure! Here is a lovely dal recipe…"}, nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextProviderErrorIsParseFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generateErr: errors.New("upstream 503")}, nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextRejectsEmptyInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{}, nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "   ")
	require.Error(t, err)
}

// TestParseTextDiscardsModelSuppliedMacros: nutrition comes only from food
// rows. A model that volunteers kcal must not influence anything.
func TestParseTextDiscardsModelSuppliedMacros(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{
		"name": "Dal", "servings": 1,
		"ingredients": [{"text": "` + f.Name + `", "amount": 200, "unit": "g", "kcal": 9999}]
	}`}, nutrition.NewRepository(db))

	d, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)
	require.Len(t, d.Ingredients, 1)
	require.Equal(t, 200.0, d.Ingredients[0].Grams, "grams come from the portion, not the model's kcal")
}

func TestParsePhotoDefaultsServingsAndNamesFromGuess(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "vegetable curry", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "150g", Confidence: 0.8}},
	}, nutrition.NewRepository(db))

	d, err := p.ParsePhoto(context.Background(), userID, []byte("jpegbytes"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "vegetable curry", d.Name)
	require.Equal(t, 1, d.Servings, "a photo cannot reveal a yield — default to 1 and let the user fix it")
	require.Equal(t, SourcePhoto, d.Source)
	require.Len(t, d.Ingredients, 1)
	require.NotNil(t, d.Ingredients[0].FoodItemID)
}

func TestParsePhotoNoGuessesIsParseFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{guesses: nil}, nutrition.NewRepository(db))

	_, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.ErrorIs(t, err, ErrParseFailed)
}

// TestParseMarksPortionAssumedWhenNoPortionPhrase: an ingredient with no
// portion phrase gets a system estimate that MUST arrive labelled (#138).
func TestParseMarksPortionAssumedWhenNoPortionPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "stew", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "", Confidence: 0.8}},
	}, nutrition.NewRepository(db))

	d, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.NoError(t, err)
	require.True(t, d.Ingredients[0].PortionAssumed)
	require.Greater(t, d.Ingredients[0].Grams, 0.0)
}

func TestDraftIsNeverPersisted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{"name":"X","servings":1,"ingredients":[{"text":"` + f.Name + `","amount":100,"unit":"g"}]}`},
		nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)

	var n int64
	require.NoError(t, db.Model(&Recipe{}).Where("user_id = ?", userID).Count(&n).Error)
	require.Zero(t, n, "parse must persist nothing")
	_ = uuid.Nil
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run TestParse -v`
Expected: FAIL to build — `undefined: NewParser`.

- [ ] **Step 3: Write the parser**

`api/internal/recipes/parse.go`. Implement exactly this structure:

```go
package recipes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// ErrParseFailed means extraction did not produce a usable recipe. The
// handler turns it into a 502 the client renders as "couldn't read that
// recipe — enter it manually", dropping the user into the manual editor.
// Parse is best-effort by nature; a dead end here must not be a dead end for
// the task.
var ErrParseFailed = errors.New("recipes: could not parse")

const (
	maxPasteLen = 6000
	// defaultAssumedGrams is the portion used when neither the model nor the
	// food row offers one. It is ALWAYS paired with PortionAssumed=true so it
	// can never be rendered as a measurement (#138).
	defaultAssumedGrams = 100.0
	// resolveLimit bounds candidates fetched per ingredient name.
	resolveLimit = 3
)

// parseSystemPrompt mirrors the discipline in the ai package's own prompts:
// identity and portion only, never a nutrition number.
const parseSystemPrompt = "You extract a structured recipe from text. Return " +
	"JSON ONLY, no prose and no code fences, exactly matching: " +
	`{"name": string, "servings": integer, "ingredients": [{"text": string, "amount": number, "unit": string}]}. ` +
	"\"name\" is the dish name. \"servings\" is how many portions the recipe " +
	"yields — use 1 if the text does not say. Each ingredient's \"text\" is " +
	"the food alone with no quantity in it; \"amount\" and \"unit\" carry the " +
	"quantity (use grams when the text gives grams). Do NOT state any calorie, " +
	"macro, or other nutrition number — nutrition is looked up separately and " +
	"any number you provide would be ignored and could mislead."

// Draft is an UNSAVED parse result. It reuses IngredientInput so the review
// sheet can post it straight back to POST /v1/recipes after the user edits.
type Draft struct {
	Name        string            `json:"name"`
	Servings    int               `json:"servings"`
	Source      string            `json:"source"`
	Ingredients []IngredientInput `json:"ingredients"`
}

type Parser struct {
	provider ai.Provider
	foods    nutrition.Repository
}

func NewParser(p ai.Provider, foods nutrition.Repository) *Parser {
	return &Parser{provider: p, foods: foods}
}

// extracted is the model's JSON shape. Any field the model invents beyond
// this — kcal included — is dropped by encoding/json.
type extracted struct {
	Name        string `json:"name"`
	Servings    int    `json:"servings"`
	Ingredients []struct {
		Text   string  `json:"text"`
		Amount float64 `json:"amount"`
		Unit   string  `json:"unit"`
	} `json:"ingredients"`
}

func (p *Parser) ParseText(ctx context.Context, userID uuid.UUID, text string) (Draft, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Draft{}, httpx.ValidationError{Message: "paste some recipe text first"}
	}
	if len(text) > maxPasteLen {
		return Draft{}, httpx.ValidationError{Message: "that recipe is too long to read"}
	}

	raw, _, err := p.provider.GenerateText(ctx, parseSystemPrompt, text)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: provider: %v", ErrParseFailed, err)
	}

	var ex extracted
	if err := json.Unmarshal([]byte(stripCodeFence(raw)), &ex); err != nil {
		return Draft{}, fmt.Errorf("%w: not json", ErrParseFailed)
	}
	if len(ex.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no ingredients", ErrParseFailed)
	}

	d := Draft{Name: strings.TrimSpace(ex.Name), Servings: ex.Servings, Source: SourcePaste}
	if d.Name == "" {
		d.Name = "Untitled recipe"
	}
	if d.Servings < 1 {
		d.Servings = 1
	}
	for _, in := range ex.Ingredients {
		name := strings.TrimSpace(in.Text)
		if name == "" {
			continue
		}
		portion := strings.TrimSpace(fmt.Sprintf("%g %s", in.Amount, in.Unit))
		if in.Amount <= 0 {
			portion = ""
		}
		d.Ingredients = append(d.Ingredients, p.resolveIngredient(ctx, userID, name, portion))
	}
	if len(d.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no usable ingredients", ErrParseFailed)
	}
	return d, nil
}

func (p *Parser) ParsePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Draft, error) {
	guesses, _, err := p.provider.IdentifyPhoto(ctx, image, mime)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: provider: %v", ErrParseFailed, err)
	}
	if len(guesses) == 0 {
		return Draft{}, fmt.Errorf("%w: nothing identified", ErrParseFailed)
	}

	// Strongest guess names the dish. A photo cannot reveal a yield, so
	// servings defaults to 1 and the user sets it in the review sheet —
	// honest, rather than an invented number.
	best := guesses[0]
	for _, g := range guesses[1:] {
		if g.Confidence > best.Confidence {
			best = g
		}
	}

	ings, _, err := p.provider.Decompose(ctx, best.Food)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: decompose: %v", ErrParseFailed, err)
	}
	if len(ings) == 0 {
		return Draft{}, fmt.Errorf("%w: no ingredients", ErrParseFailed)
	}

	d := Draft{Name: best.Food, Servings: 1, Source: SourcePhoto}
	for _, ig := range ings {
		name := strings.TrimSpace(ig.Ingredient)
		if name == "" {
			continue
		}
		d.Ingredients = append(d.Ingredients, p.resolveIngredient(ctx, userID, name, ig.PortionEstimate))
	}
	if len(d.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no usable ingredients", ErrParseFailed)
	}
	return d, nil
}

// resolveIngredient turns one extracted (name, portion phrase) into an
// IngredientInput. A name the index cannot match yields an UNRESOLVED input —
// kept verbatim, never guessed at, never dropped.
func (p *Parser) resolveIngredient(ctx context.Context, userID uuid.UUID, name, portion string) IngredientInput {
	in := IngredientInput{RawText: truncate(name, maxRawTextLen)}

	cands, err := p.foods.Resolve(ctx, userID, name, nil, resolveLimit)
	if err != nil || len(cands) == 0 {
		return in // unresolved
	}
	top := cands[0]
	id := top.Item.ID.String()
	in.FoodItemID = &id
	in.MatchScore = &top.MatchScore
	tier := top.MatchTier
	in.MatchTier = &tier

	grams, assumed := portionGrams(portion, top.Item)
	in.Grams = grams
	in.PortionAssumed = assumed
	return in
}

// portionGrams converts a portion phrase into grams against the food's own
// units, falling back to the food's serving size and then to a flat estimate.
// The bool reports that the figure is a SYSTEM ESTIMATE, not a measurement —
// it must reach the UI, or a guess renders as fact (#138).
func portionGrams(portion string, item nutrition.FoodItem) (float64, bool) {
	if amount, unit, ok := units.ParsePhrase(portion); ok {
		if g, err := units.ResolveEntered(amount, unit, item.BaseUnit, item.ServingUnits); err == nil && g > 0 {
			return g, false
		}
	}
	if item.ServingGrams > 0 {
		return item.ServingGrams, true
	}
	return defaultAssumedGrams, true
}

// stripCodeFence removes a ```json … ``` wrapper some models add despite
// being told not to. Anything else is left untouched and will fail to
// unmarshal, which is the correct outcome.
func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
```

- [ ] **Step 4: Check whether `units.ParsePhrase` exists; add it if not**

Run from `api/`: `grep -n "func Parse" internal/units/*.go`

If a function that splits a phrase like `"1 tbsp"` or `"150g"` into `(amount float64, unit string, ok bool)` already exists under another name, use that name in `portionGrams` instead. If none exists, add it to `internal/units/convert.go` with a test in `internal/units/convert_test.go` covering `"150g"` → `(150, "g", true)`, `"1 tbsp"` → `(1, "tbsp", true)`, `"2 sachets"` → `(2, "sachets", true)`, `""` → `ok=false`, and `"a pinch"` → `ok=false`.

- [ ] **Step 5: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/recipes/ ./internal/units/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/recipes/parse.go api/internal/recipes/parse_test.go api/internal/units/
git commit -m "feat(recipes): AI parse of pasted text and photos into an unsaved draft"
```

---

### Task 5: Logging a recipe — fan-out to food logs

**Files:**
- Create: `api/internal/recipes/log.go`
- Test: `api/internal/recipes/log_test.go`
- Modify: `api/internal/foodlog/service.go` — add `Source` to `CreateBatchRequest`
- Test: `api/internal/foodlog/service_test.go` — add one test for the new field

**Interfaces:**
- Consumes: `Service`, `Repository` from Tasks 2–3; `foodlog.CreateBatchRequest`, `foodlog.BatchItem`, `foodlog.FoodLog`.
- Produces:
  - `type BatchLogger interface { CreateBatch(ctx context.Context, userID uuid.UUID, req foodlog.CreateBatchRequest) ([]foodlog.FoodLog, error) }`
  - `(*Service) WithBatchLogger(bl BatchLogger) *Service`
  - `type LogRecipeRequest struct { Servings float64; MealSlot string; LoggedAt time.Time }`
  - `type LogRecipeResult struct { Logged int; Skipped []string }`
  - `(*Service) LogRecipe(ctx, userID, recipeID uuid.UUID, req LogRecipeRequest) (LogRecipeResult, error)`

- [ ] **Step 1: Add `Source` to `CreateBatchRequest`**

In `api/internal/foodlog/service.go`, extend the struct:

```go
// CreateBatchRequest logs several foods as a single meal (e.g. all items on a
// plate) in one atomic call.
type CreateBatchRequest struct {
	LoggedAt time.Time   `json:"logged_at"`
	MealSlot string      `json:"meal_slot"`
	Items    []BatchItem `json:"items"`
	// Source tags every log this batch creates. Empty means "memory", which
	// is what every caller before recipes meant and keeps existing behaviour
	// byte-identical. Recipes pass "recipe" so recipe-driven logs are
	// distinguishable from hand-entered ones in analytics.
	Source string `json:"source"`
}
```

and in `CreateBatch`, replace the hardcoded `Source: "memory"` with a resolved local computed once before the loop:

```go
	source := req.Source
	if source == "" {
		source = "memory"
	}
```

then use `Source: source` in the `FoodLog` literal.

- [ ] **Step 2: Write the failing test for the new field**

Append to `api/internal/foodlog/service_test.go`:

```go
// TestCreateBatchSourceDefaultsToMemory keeps every pre-recipes caller's
// behaviour byte-identical while letting recipes tag their own logs.
func TestCreateBatchSourceDefaultsToMemory(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID) })

	logs, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "lunch",
		Items:    []BatchItem{{FoodItemID: f.ID, QuantityGrams: 100}},
	})
	require.NoError(t, err)
	require.Equal(t, "memory", logs[0].Source)

	tagged, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "lunch", Source: "recipe",
		Items:    []BatchItem{{FoodItemID: f.ID, QuantityGrams: 100}},
	})
	require.NoError(t, err)
	require.Equal(t, "recipe", tagged[0].Source)
}
```

Match the helper names already used in that file — if its seeders are named differently, use the existing ones rather than introducing new helpers.

- [ ] **Step 3: Run the foodlog tests**

Run from `api/`: `go test ./internal/foodlog/ -run TestCreateBatch -v`
Expected: PASS, including the pre-existing batch tests (proving the default kept old behaviour).

- [ ] **Step 4: Write the failing recipe-log tests**

`api/internal/recipes/log_test.go`:

```go
package recipes

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func loggingService(t *testing.T) (*Service, uuid.UUID, nutrition.FoodItem) {
	t.Helper()
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	logRepo := foodlog.NewRepository(db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).
		WithBatchLogger(foodlog.NewService(logRepo, nutrition.NewRepository(db)))
	t.Cleanup(func() {
		db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID)
		db.Exec("DELETE FROM recipes WHERE user_id = ?", userID)
	})
	return svc, userID, f
}

// TestLogRecipeScalesGramsByServingsRatio is the core arithmetic:
// log_grams = ingredient.grams × (requested / yielded).
func TestLogRecipeScalesGramsByServingsRatio(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)

	res, err := svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 2, MealSlot: "dinner",
	})
	require.NoError(t, err)
	require.Equal(t, 1, res.Logged)
	require.Empty(t, res.Skipped)
	// 400g yields 4 servings; 2 servings is 200g.
	require.Equal(t, 200.0, lastLoggedGrams(t, svc, userID))
}

// TestLogRecipeSkipsUnresolvedAndReportsThem: an unresolved ingredient cannot
// be logged, and the user must be told rather than silently short-changed.
func TestLogRecipeSkipsUnresolvedAndReportsThem(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Curry", Servings: 1, Source: SourcePaste,
		Ingredients: []IngredientInput{
			ing(f.ID.String(), 100, "100g lentils"),
			{FoodItemID: nil, RawText: "a pinch of asafoetida"},
		},
	})
	require.NoError(t, err)

	res, err := svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.NoError(t, err)
	require.Equal(t, 1, res.Logged)
	require.Equal(t, []string{"a pinch of asafoetida"}, res.Skipped)
}

func TestLogRecipeValidates(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 2, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")},
	})
	require.NoError(t, err)
	id := uuid.MustParse(created.ID)

	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 0, MealSlot: "dinner"})
	require.Error(t, err)
	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 1, MealSlot: "brunch"})
	require.Error(t, err)
}

func TestLogRecipeRejectsAnotherUsersRecipe(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()
	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")},
	})
	require.NoError(t, err)

	_, err = svc.LogRecipe(ctx, uuid.New(), uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.Error(t, err)
}

// TestLogRecipeAllUnresolvedIsAValidationError: nothing loggable must be a
// clear message, not a silent zero-row success.
func TestLogRecipeAllUnresolvedIsAValidationError(t *testing.T) {
	svc, userID, _ := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Vibes", Servings: 1, Source: SourcePaste,
		Ingredients: []IngredientInput{{FoodItemID: nil, RawText: "a pinch of asafoetida"}},
	})
	require.NoError(t, err)

	_, err = svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.Error(t, err)
}
```

Add this helper at the bottom of `log_test.go`:

```go
// lastLoggedGrams reads back the single log the test just created.
func lastLoggedGrams(t *testing.T, svc *Service, userID uuid.UUID) float64 {
	t.Helper()
	db := testDB(t)
	var grams float64
	require.NoError(t, db.Raw(
		"SELECT quantity_grams FROM food_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		userID).Scan(&grams).Error)
	return grams
}
```

- [ ] **Step 5: Run to verify they fail**

Run from `api/`: `go test ./internal/recipes/ -run TestLogRecipe -v`
Expected: FAIL to build — `undefined: WithBatchLogger`.

- [ ] **Step 6: Write the log fan-out**

`api/internal/recipes/log.go`:

```go
package recipes

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/httpx"
)

// logSource tags every food log a recipe produces, so recipe-driven logs are
// distinguishable from hand-entered ones.
const logSource = "recipe"

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

// maxLogServings bounds one log call. A recipe is a household-scale dish; a
// request for hundreds of servings is a client bug, not a meal.
const maxLogServings = 20.0

// BatchLogger is the narrow slice of foodlog.Service this package needs. It
// is an interface so the recipes service does not depend on the whole food-log
// surface, and so tests can drive the fan-out directly.
type BatchLogger interface {
	CreateBatch(ctx context.Context, userID uuid.UUID, req foodlog.CreateBatchRequest) ([]foodlog.FoodLog, error)
}

// WithBatchLogger attaches the log fan-out target, following the functional
// option pattern already used by foodlog.Service.WithResolutionCache — added
// this way so every existing NewService call site keeps working unchanged.
func (s *Service) WithBatchLogger(bl BatchLogger) *Service {
	s.batch = bl
	return s
}

type LogRecipeRequest struct {
	Servings float64   `json:"servings"`
	MealSlot string    `json:"meal_slot"`
	LoggedAt time.Time `json:"logged_at"`
}

// LogRecipeResult reports what actually reached the diary. Skipped names the
// unresolved ingredients that could not be logged, so the client can tell the
// user what was left out instead of quietly under-reporting the meal.
type LogRecipeResult struct {
	Logged  int      `json:"logged"`
	Skipped []string `json:"skipped"`
}

// LogRecipe fans a recipe out into one food_logs row per RESOLVED ingredient,
// grams scaled by (requested servings / recipe yield).
//
// Deliberately NOT one synthetic "recipe" row: the diary, log_corrections,
// memory and every macro computation operate on food-item rows, so a
// synthetic row would be invisible to the food index and uncorrectable.
// Saved meals already fan out this way.
func (s *Service) LogRecipe(ctx context.Context, userID, recipeID uuid.UUID, req LogRecipeRequest) (LogRecipeResult, error) {
	if s.batch == nil {
		return LogRecipeResult{}, httpx.ValidationError{Message: "logging is unavailable"}
	}
	if req.Servings <= 0 {
		return LogRecipeResult{}, httpx.ValidationError{Message: "servings must be positive"}
	}
	if req.Servings > maxLogServings {
		return LogRecipeResult{}, httpx.ValidationError{Message: "that is too many servings to log at once"}
	}
	if !validMealSlots[req.MealSlot] {
		return LogRecipeResult{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}

	rec, err := s.repo.GetForUser(ctx, userID, recipeID)
	if err != nil {
		return LogRecipeResult{}, err // gorm.ErrRecordNotFound → 404
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, []uuid.UUID{rec.ID})
	if err != nil {
		return LogRecipeResult{}, err
	}

	ratio := req.Servings / float64(rec.Servings)
	items := make([]foodlog.BatchItem, 0, len(rows))
	skipped := []string{}
	for _, r := range rows {
		if r.FoodItemID == nil {
			skipped = append(skipped, r.RawText)
			continue
		}
		grams := r.Grams * ratio
		if grams <= 0 {
			skipped = append(skipped, r.RawText)
			continue
		}
		// The entered pair is deliberately NOT forwarded: it describes ONE
		// recipe's worth ("2 sachets"), and a fractional-serving log needs
		// the scaled grams instead. Forwarding it would make the server
		// re-resolve the unscaled amount and log the wrong quantity.
		items = append(items, foodlog.BatchItem{FoodItemID: *r.FoodItemID, QuantityGrams: grams})
	}
	if len(items) == 0 {
		return LogRecipeResult{}, httpx.ValidationError{Message: "no ingredients in this recipe can be logged yet"}
	}

	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	logs, err := s.batch.CreateBatch(ctx, userID, foodlog.CreateBatchRequest{
		LoggedAt: loggedAt, MealSlot: req.MealSlot, Items: items, Source: logSource,
	})
	if err != nil {
		return LogRecipeResult{}, err
	}
	return LogRecipeResult{Logged: len(logs), Skipped: skipped}, nil
}
```

Then add the field to the `Service` struct in `service.go`:

```go
type Service struct {
	repo  Repository
	foods nutrition.Repository
	batch BatchLogger
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/recipes/ ./internal/foodlog/ -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/internal/recipes/log.go api/internal/recipes/log_test.go api/internal/foodlog/service.go api/internal/foodlog/service_test.go
git commit -m "feat(recipes): log a recipe by fanning out scaled portions to food logs"
```

---

### Task 6: HTTP handler and router wiring

**Files:**
- Create: `api/internal/recipes/handler.go`
- Test: `api/internal/recipes/handler_test.go`
- Modify: `api/internal/server/router.go`
- Modify: `api/cmd/api/main.go`
- Test: `api/internal/server/router_test.go`

**Interfaces:**
- Consumes: `Service`, `Parser`, `ErrParseFailed` from Tasks 3–5.
- Produces: `NewHandler(svc *Service, parser *Parser) Handler` with methods `List`, `Get`, `Create`, `Update`, `Delete`, `Parse`, `Log`.

- [ ] **Step 1: Write the handler**

`api/internal/recipes/handler.go`:

```go
package recipes

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// maxPhotoBytes caps an uploaded recipe photo, matching resolve's limit.
const maxPhotoBytes = 8 << 20
const maxPhotoBodyBytes = maxPhotoBytes + 1<<10

type Handler struct {
	svc    *Service
	parser *Parser
}

func NewHandler(svc *Service, parser *Parser) Handler { return Handler{svc: svc, parser: parser} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// recipeID parses the path id. An unparseable id is a 400; a well-formed id
// the caller does not own becomes a 404 further down, never a 403, so ids
// stay non-enumerable.
func (h Handler) recipeID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid recipe id")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) notFoundOr(c *gin.Context, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "recipe not found")
		return
	}
	httpx.RespondServiceError(c, err)
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	out, err := h.svc.List(c.Request.Context(), userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not list recipes")
		return
	}
	httpx.OK(c, out)
}

func (h Handler) Get(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	v, err := h.svc.Get(c.Request.Context(), userID, id)
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, v)
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req SaveRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed recipe body")
		return
	}
	v, err := h.svc.Create(c.Request.Context(), userID, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": v})
}

func (h Handler) Update(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	var req SaveRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed recipe body")
		return
	}
	v, err := h.svc.Update(c.Request.Context(), userID, id, req)
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, v)
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), userID, id); err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}

// Parse accepts pasted text (JSON) or a photo (multipart) and returns an
// UNSAVED draft. It writes nothing, so an abandoned parse leaves no rows.
func (h Handler) Parse(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if h.parser == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "unavailable", "recipe reading is unavailable")
		return
	}

	var (
		draft Draft
		err   error
	)
	if ct := c.ContentType(); ct == "multipart/form-data" {
		// Bound the body BEFORE multipart parsing buffers it, so an oversized
		// upload is rejected while streaming in rather than after being fully
		// read into memory — same ordering as resolve.Handler.ResolvePhoto.
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPhotoBodyBytes)
		file, header, ferr := c.Request.FormFile("photo")
		if ferr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "a photo is required")
			return
		}
		defer file.Close()
		image, rerr := io.ReadAll(file)
		if rerr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "could not read the photo")
			return
		}
		draft, err = h.parser.ParsePhoto(c.Request.Context(), userID, image, header.Header.Get("Content-Type"))
	} else {
		var body struct {
			Text string `json:"text"`
		}
		if berr := c.ShouldBindJSON(&body); berr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed parse body")
			return
		}
		draft, err = h.parser.ParseText(c.Request.Context(), userID, body.Text)
	}

	if err != nil {
		// A parse failure is 502, not 500: the upstream model could not read
		// it. The client renders this as "enter it manually" and opens the
		// manual editor — a dead end here must not be a dead end for the task.
		if errors.Is(err, ErrParseFailed) {
			httpx.Error(c, http.StatusBadGateway, "parse_failed",
				"Couldn't read that recipe — enter it manually")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, draft)
}

func (h Handler) Log(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	var req LogRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed log body")
		return
	}
	res, err := h.svc.LogRecipe(c.Request.Context(), userID, id, req)
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": res})
}
```

- [ ] **Step 2: Write the handler tests**

`api/internal/recipes/handler_test.go`. Model the setup on `api/internal/savedmeals/handler_test.go` — read that file first and copy its gin test-context and auth-injection pattern exactly. Cover:

```
TestListRequiresAuth              → 401 when no user in context
TestGetAnotherUsersRecipeIs404    → 404, never 403
TestCreateRejectsMalformedBody    → 400
TestCreateReturns201WithEnvelope  → 201 and a {"data":{…}} body
TestParseFailureIs502WithMessage  → 502, code "parse_failed"
TestLogReturns201WithSkipped      → 201 and skipped[] present
```

- [ ] **Step 3: Wire the routes**

In `api/internal/server/router.go`, add the import `"github.com/tesserix/kora/api/internal/recipes"` and, immediately after the saved-meals block (around line 212), insert:

```go
		// Recipes. The parser is nil when the resolve engine is disabled (no
		// provider key) — Handler.Parse then returns 503 and the manual
		// editor still works, so recipes degrade rather than disappear.
		recipeSvc := recipes.NewService(recipes.NewRepository(deps.DB), foodRepo).
			WithBatchLogger(foodlog.NewService(logRepo, foodRepo))
		var recipeParser *recipes.Parser
		if deps.Provider != nil {
			recipeParser = recipes.NewParser(deps.Provider, foodRepo)
		}
		recipeHandler := recipes.NewHandler(recipeSvc, recipeParser)
		v1.GET("/recipes", recipeHandler.List)
		v1.POST("/recipes", recipeHandler.Create)
		v1.POST("/recipes/parse", recipeHandler.Parse)
		v1.GET("/recipes/:id", recipeHandler.Get)
		v1.PUT("/recipes/:id", recipeHandler.Update)
		v1.DELETE("/recipes/:id", recipeHandler.Delete)
		v1.POST("/recipes/:id/log", recipeHandler.Log)
```

Register `/recipes/parse` **before** `/recipes/:id` as written above; Gin's radix tree handles the two, but keeping the static path first makes the intent obvious to the next reader.

**Correction (found during Task 6):** an earlier draft of this plan told you to add a new `AIProvider ai.Provider` field to `Deps`. **Do not.** `Deps` already carries a `Provider ai.Provider` field (used by the coach handler), `router.go` already imports package `ai`, and `main.go` assigns the same `aiProvider` value to it. Adding a second field produced two names for one object with no path where they could differ. Use the existing `deps.Provider` for the recipe parser's nil-check and construction.

- [ ] **Step 4: Pass the provider in from main**

In `api/cmd/api/main.go`, `buildResolveEngine` already returns `(*resolve.Handler, ai.Provider, ai.Cache)`, and the `server.Deps` literal already sets `Provider: aiProvider`. Nothing to add here — recipes reuses that field. Do not introduce a second provider field.

Run `grep -n "Resolver:" api/cmd/api/main.go` to locate it.

- [ ] **Step 5: Add a route-registration test**

In `api/internal/server/router_test.go`, extend the existing route-presence test with the seven recipe routes, following the `hasRoute(r.Routes(), "POST", "/v1/resolve/text")` pattern already in that file. Also assert that with `Provider: nil` the recipe routes are still registered — recipes must not disappear when the AI provider is absent. Make the provider-present and provider-nil tests genuinely differ (one sets a non-nil `ai.Provider` stub), or they are duplicates that only cover the nil case.

- [ ] **Step 6: Run everything**

Run from `api/`:

```bash
go build ./... && go vet ./... && go test ./internal/recipes/ ./internal/server/ ./internal/foodlog/ -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/internal/recipes/handler.go api/internal/recipes/handler_test.go api/internal/server/router.go api/internal/server/router_test.go api/cmd/api/main.go
git commit -m "feat(recipes): HTTP surface and router wiring"
```

---

### Task 7: Mobile types and hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/recipes.test.tsx`

**Interfaces:**
- Consumes: the HTTP surface from Task 6.
- Produces: `Recipe`, `RecipeIngredient`, `RecipeDraft`, `LogRecipeResult` types; hooks `useRecipes`, `useRecipe`, `useCreateRecipe`, `useUpdateRecipe`, `useDeleteRecipe`, `useParseRecipe`, `useLogRecipe`.

- [ ] **Step 1: Add the types**

Append to `apps/mobile/src/api/types.ts` (match the file's existing formatting):

```typescript
export interface RecipeIngredient {
  food_item_id: string | null;
  name: string;
  raw_text: string;
  /** false means the food index has no match — the line shows but adds no macros. */
  resolved: boolean;
  grams: number;
  entered_amount: number | null;
  entered_unit: string | null;
  /** The grams above are a system estimate, not a measurement. Must be rendered as such. */
  portion_assumed: boolean;
  match_score: number | null;
  match_tier: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  source: "manual" | "paste" | "photo";
  ingredients: RecipeIngredient[];
  /** > 0 means the totals below are PARTIAL. Say so in the UI. */
  unresolved_count: number;
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  total_fiber_g: number;
  per_serving_kcal: number;
  per_serving_protein_g: number;
  per_serving_carbs_g: number;
  per_serving_fat_g: number;
  per_serving_fiber_g: number;
}

export interface RecipeIngredientInput {
  food_item_id: string | null;
  raw_text: string;
  grams: number;
  entered_amount?: number | null;
  entered_unit?: string | null;
  portion_assumed?: boolean;
  match_score?: number | null;
  match_tier?: string | null;
}

export interface RecipeDraft {
  name: string;
  servings: number;
  source: "paste" | "photo";
  ingredients: RecipeIngredientInput[];
}

export interface SaveRecipeBody {
  name: string;
  servings: number;
  source: "manual" | "paste" | "photo";
  ingredients: RecipeIngredientInput[];
}

export interface LogRecipeResult {
  logged: number;
  /** Unresolved ingredients that could not be logged — tell the user. */
  skipped: string[];
}
```

- [ ] **Step 2: Write the failing hook tests**

`apps/mobile/src/api/__tests__/recipes.test.tsx`. Read `apps/mobile/src/api/__tests__/savedMeals.test.tsx` first and copy its wrapper, `mockApiFetch` setup and assertion style exactly. Cover:

```
useRecipes fetches /v1/recipes
useRecipe fetches /v1/recipes/:id
useCreateRecipe POSTs /v1/recipes and invalidates the recipes query
useUpdateRecipe PUTs /v1/recipes/:id
useDeleteRecipe DELETEs /v1/recipes/:id
useParseRecipe POSTs text to /v1/recipes/parse
useLogRecipe POSTs /v1/recipes/:id/log and invalidates the logs + dashboard queries
```

- [ ] **Step 3: Run to verify they fail**

Run from `apps/mobile/`: `npx jest src/api/__tests__/recipes.test.tsx`
Expected: FAIL — `useRecipes is not a function`.

- [ ] **Step 4: Add the hooks**

In `apps/mobile/src/api/hooks.ts`, add after the saved-meals hooks (around line 360). Match the surrounding hooks' exact `queryKey`, `apiFetch` and invalidation conventions — read `useSavedMeals` / `useCreateSavedMeal` immediately above and mirror them.

```typescript
export function useRecipes() {
  const query = useQuery({
    queryKey: ["recipes"],
    queryFn: () => apiFetch("/v1/recipes") as Promise<Recipe[]>,
  });
  // Same by-product cache fill as useSavedMeals: the foods nested in each
  // recipe are worth caching for offline logging.
  useEffect(() => {
    if (query.data) cacheFoodsQuietly(foodsFromRecipes(query.data), "summary");
  }, [query.data]);
  return query;
}

export function useRecipe(id: string) {
  return useQuery({
    queryKey: ["recipes", id],
    queryFn: () => apiFetch(`/v1/recipes/${id}`) as Promise<Recipe>,
    enabled: Boolean(id),
  });
}

export function useCreateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveRecipeBody) =>
      apiFetch("/v1/recipes", { method: "POST", body: JSON.stringify(body) }) as Promise<Recipe>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recipes"] }),
  });
}

export function useUpdateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SaveRecipeBody }) =>
      apiFetch(`/v1/recipes/${id}`, { method: "PUT", body: JSON.stringify(body) }) as Promise<Recipe>,
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["recipes"] });
      qc.invalidateQueries({ queryKey: ["recipes", id] });
    },
  });
}

export function useDeleteRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/recipes/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recipes"] }),
  });
}

// useParseRecipe never writes: it returns an UNSAVED draft the review sheet
// edits before POSTing to /v1/recipes. No cache invalidation, by design.
export function useParseRecipe() {
  return useMutation({
    mutationFn: (input: { text: string } | { photo: FormData }) =>
      "text" in input
        ? (apiFetch("/v1/recipes/parse", {
            method: "POST",
            body: JSON.stringify({ text: input.text }),
          }) as Promise<RecipeDraft>)
        : (apiFetch("/v1/recipes/parse", { method: "POST", body: input.photo }) as Promise<RecipeDraft>),
  });
}

export function useLogRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { servings: number; meal_slot: string; logged_at: string } }) =>
      apiFetch(`/v1/recipes/${id}/log`, {
        method: "POST",
        body: JSON.stringify(body),
      }) as Promise<LogRecipeResult>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

Add `foodsFromRecipes` next to the existing `foodsFromSavedMeals` in whichever module defines it (`grep -rn "foodsFromSavedMeals" apps/mobile/src` to find it), returning the nested `FoodItem`-shaped values from resolved ingredients only.

Confirm the exact `queryKey` strings used by the dashboard and diary before invalidating — `grep -n 'queryKey: \["' apps/mobile/src/api/hooks.ts` — and use those, not the placeholders above, if they differ.

- [ ] **Step 5: Run the tests to verify they pass**

Run from `apps/mobile/`: `npx jest src/api/__tests__/recipes.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/
git commit -m "feat(recipes): mobile types and query hooks"
```

---

### Task 8: Recipes list and detail/editor screens

**Files:**
- Create: `apps/mobile/app/recipes.tsx`
- Create: `apps/mobile/app/recipe/[id].tsx`
- Test: `apps/mobile/app/__tests__/recipes.test.tsx`

**Interfaces:**
- Consumes: the hooks from Task 7.
- Produces: two routed screens.

- [ ] **Step 1: Read the patterns to follow**

Read these three files completely before writing anything — the new screens must be indistinguishable in style from them:

- `apps/mobile/app/groups.tsx` — list screen with empty state and a create affordance
- `apps/mobile/app/group/[id].tsx` — detail screen with back-nav and owner actions
- `apps/mobile/app/log.tsx` lines 360–395 — `GroupedSection` + `MealRow` usage

- [ ] **Step 2: Write the list screen**

`apps/mobile/app/recipes.tsx`. Requirements:

- `useRecipes()`; loading, error and empty states all distinct — empty reads "Paste or photograph a recipe to reuse it."
- Each row: name, `per_serving_kcal` rounded, and `servings` as "makes N".
- When `unresolved_count > 0`, the row shows a muted "N need attention" note. The totals must never be presented as complete when this is non-zero.
- Header actions: "Paste" and "Photo", both opening the parse sheet from Task 9; plus "New" for the blank manual editor.
- Tapping a row navigates to `/recipe/[id]`.

- [ ] **Step 3: Write the detail/editor screen**

`apps/mobile/app/recipe/[id].tsx`. Requirements:

- `useRecipe(id)`; back-nav in the header, matching `app/group/[id].tsx`.
- Per-serving macro summary at the top; totals below it, labelled "whole recipe".
- A servings stepper. Changing it calls `useUpdateRecipe` with the unchanged ingredient list — per-serving figures come back recomputed from the server, never from local arithmetic.
- Ingredient rows show name (or `raw_text` when unresolved), grams, and kcal. An unresolved row is visually distinct and offers "Find a match" which opens the existing food search. A row with `portion_assumed` shows an "estimated" marker — this is issue #138's rule and is not optional.
- A "Log" action opening a slot + servings picker, calling `useLogRecipe`. On success the toast reports the count and, when `skipped.length > 0`, names what was left out.
- Delete with a confirmation, then `router.back()`.
- Every mutation has an `onError` that shows a toast. No silently disabled buttons (#83).

- [ ] **Step 4: Write the screen tests**

`apps/mobile/app/__tests__/recipes.test.tsx`. Read `apps/mobile/app/__tests__/log.test.tsx` first for the render harness and mocking style. Cover:

```
the list renders a recipe with its per-serving kcal
the list shows the "need attention" note when unresolved_count > 0
the empty state renders when there are no recipes
the detail screen renders an unresolved ingredient as needing a match
the detail screen marks a portion_assumed ingredient as estimated
logging shows a toast naming skipped ingredients
a failed mutation shows an error toast
```

- [ ] **Step 5: Run the tests**

Run from `apps/mobile/`: `npx jest app/__tests__/recipes.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run from `apps/mobile/`: `npx tsc --noEmit && npx eslint app/recipes.tsx app/recipe/\[id\].tsx src/api/hooks.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/recipes.tsx apps/mobile/app/recipe/ apps/mobile/app/__tests__/recipes.test.tsx
git commit -m "feat(recipes): recipe list and detail screens"
```

---

### Task 9: Parse-review sheet and the Log-screen tab

**Files:**
- Create: `apps/mobile/src/components/recipes/RecipeParseSheet.tsx`
- Modify: `apps/mobile/app/log.tsx`
- Test: `apps/mobile/src/components/recipes/__tests__/RecipeParseSheet.test.tsx`

**Interfaces:**
- Consumes: `useParseRecipe`, `useCreateRecipe` from Task 7; `RecipeDraft`, `RecipeIngredientInput` from Task 7.
- Produces: `<RecipeParseSheet />` and a "Recipes" tab in the Log screen.

- [ ] **Step 1: Read the pattern to follow**

Read `apps/mobile/app/capture-review.tsx` completely. The parse-review sheet is the same idea — a model's guess presented for confirmation before anything is written — and must reuse its confidence and assumed-portion presentation rather than inventing a second visual language for the same concept.

- [ ] **Step 2: Write the sheet**

`apps/mobile/src/components/recipes/RecipeParseSheet.tsx`. Requirements:

- Two entry modes: a paste textarea, and a photo picker reusing whatever image-picking helper `capture.tsx` already uses (`grep -n "ImagePicker" apps/mobile/app/capture.tsx`).
- On submit, call `useParseRecipe`. While pending, show progress — parse involves a model round trip and can take seconds.
- **On `parse_failed` (502), do not show a dead end.** Open the manual editor pre-filled with the pasted text as a single unresolved ingredient and a message explaining it could not be read. This is the spec's explicit rule.
- On success, render the editable draft: name field, servings stepper, and one row per ingredient showing `raw_text`, the matched food name when resolved, and the grams.
- An unresolved ingredient is clearly marked and can be matched via food search or removed. An ingredient with `portion_assumed` is marked "estimated".
- "Save recipe" calls `useCreateRecipe` with the edited draft; on success, close and navigate to the new recipe.
- `onError` toasts on both mutations.

- [ ] **Step 3: Add the Log-screen tab**

In `apps/mobile/app/log.tsx`, add a `"recipes"` value to the `memTab` union alongside `"saved" | "pinned" | "usual_meals"`, and a branch rendering the caller's recipes in a `GroupedSection` of `MealRow`s exactly like the saved-meals branch at lines 371–390. Tapping a row opens the servings/slot picker and logs via `useLogRecipe`; the header offers "+ New recipe" opening the parse sheet.

- [ ] **Step 4: Write the sheet tests**

`apps/mobile/src/components/recipes/__tests__/RecipeParseSheet.test.tsx`. Cover:

```
pasting text and submitting calls the parse endpoint
a successful parse renders each extracted ingredient
an unresolved ingredient is marked as needing a match
a portion_assumed ingredient is marked estimated
a 502 parse failure opens the manual editor rather than an error dead end
saving posts the edited draft to /v1/recipes
```

- [ ] **Step 5: Run all mobile tests**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS, clean typecheck. Fix any pre-existing snapshot drift caused by the new Log-screen tab.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/recipes/ apps/mobile/app/log.tsx
git commit -m "feat(recipes): parse-review sheet and recipes tab on the log screen"
```

---

### Task 10: Full verification and simulator smoke test

**Files:** none created; this task proves the feature works end to end.

- [ ] **Step 1: Run the whole backend suite**

Run from `api/`:

```bash
go build ./... && go vet ./... && go test ./... -race
```

Expected: PASS with no new failures. Note any pre-existing failures separately — do not "fix" unrelated red by changing recipe code.

- [ ] **Step 2: Run the whole mobile suite**

Run from `apps/mobile/`:

```bash
npx tsc --noEmit && npx eslint . && npx jest
```

Expected: clean.

- [ ] **Step 3: Start the API against the dev database**

Run from `api/`: `go run ./cmd/api`

Confirm the migration is applied and the routes registered:

```bash
curl -s localhost:8080/health
```

- [ ] **Step 4: Boot the simulator and run the app**

Boot **iPhone 17 Pro** — not the Pro Max; the Pro Max is the wrong rig for this project.

```bash
xcrun simctl boot "iPhone 17 Pro"
cd apps/mobile && npx expo start --ios
```

**Do not trigger an EAS build.** This is a local simulator run only.

- [ ] **Step 5: Drive the flow by hand**

Confirm each of these on the simulator:

1. Log tab → Recipes tab renders (empty state first).
2. "+ New recipe" → paste a real recipe → parse returns a draft with ingredients.
3. An unresolved ingredient is visibly marked, not silently missing.
4. Save → the recipe appears in the list with per-serving kcal.
5. Open it → change servings from 4 to 8 → per-serving kcal halves.
6. Log 2 servings → the diary shows the scaled ingredient rows.
7. If any ingredient was unresolved, the toast names what was skipped.
8. Delete the recipe → it disappears from the list.

- [ ] **Step 6: Record the result**

Write what was verified, and anything that did not work, into `docs/superpowers/HANDOFF-2026-08-13-recipes.md`, following the structure of the existing `docs/superpowers/HANDOFF-*.md` files: what is done and live-verified, what is deferred, reusable primitives learned, and likely next moves (sub-project 2, the meal planner).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/HANDOFF-2026-08-13-recipes.md
git commit -m "docs: recipes handoff with simulator verification results"
```

---

## Deferred to later slices

- **URL import** (#25's third input) — its own slice once the paste prompt is proven.
- **Re-resolution of unresolved ingredients** — a background retry after the food index grows. `raw_text` is stored specifically to make this possible.
- **Allergen checks** (#36) on recipe ingredients.
- **Sharing** — sub-project 4 adds household visibility without changing ownership.
