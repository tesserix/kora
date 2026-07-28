# Saved Meals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save a detected "usual meal" as a named, editable, persisted meal (rename, remove items, adjust grams, default slot) that shows in a "Saved" section (Log tab + Home strip) and logs in one tap.

**Architecture:** New Go package `api/internal/savedmeals/` (two tables `saved_meals` + `saved_meal_items`, transactional CRUD, `/v1/saved-meals`). Mobile: `useSavedMeals`/create/update/delete hooks, a `SavedMealSheet` editor behind a root `SavedMealSheetProvider`, a bookmark affordance on `MealRow`, a Log "Saved" tab, and a `SavedMealsStrip` on Home. Logging reuses the existing `POST /v1/logs/batch` via `useInstantLog.logMeal`.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate; Expo/React Native + TypeScript + TanStack Query. Spec: `docs/superpowers/specs/2026-07-28-kora-saved-meals-design.md`.

## Global Constraints

- **User isolation on every query** (meals + items scoped through the owning user). **Macros server-side only** — client sends `food_item_id + grams`; server computes `perItemPer100g × grams / 100.0` (raw float64, NO rounding; UI rounds). Never fabricate numbers.
- **Two-table writes in a transaction.** `SavedMeal` json = `{id,name,meal_slot,items:[{food_item_id,name,grams,kcal,protein_g,carbs_g,fat_g,fiber_g}],kcal,protein_g,carbs_g,fat_g,fiber_g}`.
- **Valid meal slots:** `breakfast|lunch|dinner|snack`. **Cap:** `maxSavedMeals = 50` (400 on exceed). Name trimmed non-empty (≤80). ≥1 item, grams>0 each, food must exist.
- **Standard envelope:** `httpx.OK`→`{data}`; POST 201 `{data}`; errors `httpx.Error`/`httpx.RespondServiceError`; service 400s are `httpx.ValidationError{Message}`. Go errors wrapped `fmt.Errorf("savedmeals: <op>: %w", err)`. Import path `github.com/tesserix/kora/api/internal/savedmeals`.
- **Go tests:** `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go test -race -p 1 ./internal/savedmeals/...` (FOREGROUND). Self-seed food_items/users + cleanup (never `cmd/seed`). Run `go run ./cmd/migrate` first to apply `000017`. A `t.Skipf` SKIP is not a pass.
- **Mobile tests:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` (FOREGROUND). RNTL v14 → `await render`. `mock`-prefixed closure vars in `jest.mock()` (babel-jest-hoist).
- **Mobile:** tokens-only; immutable; reuse `MealRow`/`Sheet`/`Button`/`AppText`/`Overline`/`Segmented`/`GroupedSection`/`foodVisual`/`hslToHex`/`useInstantLog`.
- **Git:** branch `usual-meals` (off `main`). Single-line conventional commits, no signature. Stage named files only — never `git add -A`.

---

### Task 1: saved_meals migration + models + repository (Go)

**Files:**
- Create: `api/internal/database/migrations/000017_saved_meals.up.sql`, `.down.sql`
- Create: `api/internal/savedmeals/model.go`, `api/internal/savedmeals/repository.go`
- Test: `api/internal/savedmeals/repository_test.go`

**Interfaces:**
- Produces: `type SavedMeal`, `type SavedMealItem`, `type ItemRow`; `NewRepository`; `Create(ctx, m SavedMeal, items []SavedMealItem) (SavedMeal, error)`; `ListForUser(ctx, userID) ([]SavedMeal, error)`; `ItemsForMeals(ctx, mealIDs []uuid.UUID) ([]ItemRow, error)`; `Replace(ctx, userID, mealID uuid.UUID, name, slot string, items []SavedMealItem) error`; `DeleteForUser(ctx, userID, mealID uuid.UUID) error`; `CountForUser(ctx, userID) (int64, error)`.

- [ ] **Step 1: Migration** — `000017_saved_meals.up.sql`:

```sql
CREATE TABLE saved_meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    meal_slot TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_saved_meals_user ON saved_meals (user_id);

CREATE TABLE saved_meal_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saved_meal_id UUID NOT NULL REFERENCES saved_meals(id) ON DELETE CASCADE,
    food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
    grams DOUBLE PRECISION NOT NULL,
    position INT NOT NULL
);
CREATE INDEX ix_saved_meal_items_meal ON saved_meal_items (saved_meal_id);
```

`.down.sql`:

```sql
DROP TABLE IF EXISTS saved_meal_items;
DROP TABLE IF EXISTS saved_meals;
```

- [ ] **Step 2: Models** — `api/internal/savedmeals/model.go`:

```go
package savedmeals

import (
	"time"

	"github.com/google/uuid"
)

type SavedMeal struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index"`
	Name      string    `gorm:"not null"`
	MealSlot  string    `gorm:"not null"`
	CreatedAt time.Time
}

func (SavedMeal) TableName() string { return "saved_meals" }

type SavedMealItem struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	SavedMealID uuid.UUID `gorm:"type:uuid;not null;index"`
	FoodItemID  uuid.UUID `gorm:"type:uuid;not null"`
	Grams       float64   `gorm:"not null"`
	Position    int       `gorm:"not null"`
}

func (SavedMealItem) TableName() string { return "saved_meal_items" }

// ItemRow is a joined read of an item with its food's name + per-100g macros,
// so List can enrich without an N+1 GetByID per item.
type ItemRow struct {
	SavedMealID    uuid.UUID
	FoodItemID     uuid.UUID
	Grams          float64
	Position       int
	Name           string
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}
```

- [ ] **Step 3: Failing repository test** — `api/internal/savedmeals/repository_test.go`:

```go
package savedmeals

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
		id, "sm-"+id.String(), "sm@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedFood(t *testing.T, db *gorm.DB, kcal float64) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{Name: "SM Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: kcal, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestCreateListReplaceDeleteScoped(t *testing.T) {
	db := testDB(t)
	userA := seedUser(t, db)
	userB := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	f2 := seedFood(t, db, 200)
	repo := NewRepository(db)
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id IN (?, ?)", userA, userB) })

	created, err := repo.Create(ctx, SavedMeal{UserID: userA, Name: "Bfast", MealSlot: "breakfast"},
		[]SavedMealItem{{FoodItemID: f1.ID, Grams: 100}, {FoodItemID: f2.ID, Grams: 50}})
	require.NoError(t, err)

	list, err := repo.ListForUser(ctx, userA)
	require.NoError(t, err)
	require.Len(t, list, 1)

	rows, err := repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, 0, rows[0].Position) // ordered by position
	require.Equal(t, 1, rows[1].Position)

	// Replace: rename + drop to a single item.
	require.NoError(t, repo.Replace(ctx, userA, created.ID, "My Bfast", "lunch",
		[]SavedMealItem{{FoodItemID: f1.ID, Grams: 120}}))
	rows, err = repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, 120.0, rows[0].Grams)
	list, _ = repo.ListForUser(ctx, userA)
	require.Equal(t, "My Bfast", list[0].Name)
	require.Equal(t, "lunch", list[0].MealSlot)

	// Isolation: user B can't see, replace, or delete user A's meal.
	bList, _ := repo.ListForUser(ctx, userB)
	require.Empty(t, bList)
	require.Error(t, repo.Replace(ctx, userB, created.ID, "hax", "dinner", []SavedMealItem{{FoodItemID: f1.ID, Grams: 10}}))
	require.Error(t, repo.DeleteForUser(ctx, userB, created.ID))
	list, _ = repo.ListForUser(ctx, userA)
	require.Len(t, list, 1)

	// Delete cascades items.
	require.NoError(t, repo.DeleteForUser(ctx, userA, created.ID))
	rows, err = repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Empty(t, rows)
}

func TestCountForUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	repo := NewRepository(db)
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	n, err := repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(0), n)
	_, err = repo.Create(ctx, SavedMeal{UserID: userID, Name: "x", MealSlot: "snack"}, []SavedMealItem{{FoodItemID: f1.ID, Grams: 50}})
	require.NoError(t, err)
	n, err = repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}
```

- [ ] **Step 4: Apply migration + RED**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" go run ./cmd/migrate && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" go test -race -p 1 ./internal/savedmeals/...`
Expected: FAIL — no `NewRepository`.

- [ ] **Step 5: Implement repository** — `api/internal/savedmeals/repository.go`:

```go
package savedmeals

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

// Create inserts the meal and its items (with position) in one transaction.
func (r Repository) Create(ctx context.Context, m SavedMeal, items []SavedMealItem) (SavedMeal, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&m).Error; err != nil {
			return err
		}
		return insertItems(tx, m.ID, items)
	})
	if err != nil {
		return SavedMeal{}, fmt.Errorf("savedmeals: create: %w", err)
	}
	return m, nil
}

func insertItems(tx *gorm.DB, mealID uuid.UUID, items []SavedMealItem) error {
	if len(items) == 0 {
		return nil
	}
	rows := make([]SavedMealItem, len(items))
	for i, it := range items {
		rows[i] = SavedMealItem{SavedMealID: mealID, FoodItemID: it.FoodItemID, Grams: it.Grams, Position: i}
	}
	return tx.Create(&rows).Error
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]SavedMeal, error) {
	out := []SavedMeal{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("savedmeals: list: %w", err)
	}
	return out, nil
}

// ItemsForMeals returns items for the given meals, joined to food_items for
// name + per-100g macros, ordered by (meal, position).
func (r Repository) ItemsForMeals(ctx context.Context, mealIDs []uuid.UUID) ([]ItemRow, error) {
	out := []ItemRow{}
	if len(mealIDs) == 0 {
		return out, nil
	}
	err := r.db.WithContext(ctx).
		Table("saved_meal_items AS smi").
		Select("smi.saved_meal_id, smi.food_item_id, smi.grams, smi.position, fi.name, fi.kcal_per_100g AS kcal_per100g, fi.protein_per_100g AS protein_per100g, fi.carbs_per_100g AS carbs_per100g, fi.fat_per_100g AS fat_per100g, fi.fiber_per_100g AS fiber_per100g").
		Joins("JOIN food_items fi ON fi.id = smi.food_item_id").
		Where("smi.saved_meal_id IN ?", mealIDs).
		Order("smi.saved_meal_id, smi.position").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("savedmeals: items: %w", err)
	}
	return out, nil
}

// Replace updates a user-owned meal's name/slot and swaps its items atomically.
func (r Repository) Replace(ctx context.Context, userID, mealID uuid.UUID, name, slot string, items []SavedMealItem) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing SavedMeal
		if err := tx.Where("id = ? AND user_id = ?", mealID, userID).First(&existing).Error; err != nil {
			return err // gorm.ErrRecordNotFound if absent/not owned
		}
		if err := tx.Model(&SavedMeal{}).Where("id = ?", mealID).Updates(map[string]any{"name": name, "meal_slot": slot}).Error; err != nil {
			return err
		}
		if err := tx.Where("saved_meal_id = ?", mealID).Delete(&SavedMealItem{}).Error; err != nil {
			return err
		}
		return insertItems(tx, mealID, items)
	})
	if err != nil {
		return fmt.Errorf("savedmeals: replace: %w", err)
	}
	return nil
}

func (r Repository) DeleteForUser(ctx context.Context, userID, mealID uuid.UUID) error {
	res := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", mealID, userID).Delete(&SavedMeal{})
	if res.Error != nil {
		return fmt.Errorf("savedmeals: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("savedmeals: delete: %w", gorm.ErrRecordNotFound)
	}
	return nil
}

func (r Repository) CountForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&SavedMeal{}).Where("user_id = ?", userID).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("savedmeals: count: %w", err)
	}
	return n, nil
}
```

> Note: GORM `Scan` maps snake_case columns to `ItemRow` fields (`kcal_per100g` → `KcalPer100g`). The `AS kcal_per100g` aliases keep the mapping unambiguous. If a `Scan` field comes back zero unexpectedly, verify the alias↔field name and adjust (the food_items columns are `kcal_per_100g` etc.).

- [ ] **Step 6: GREEN + build**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" go test -race -p 1 ./internal/savedmeals/... && go build ./...`
Expected: 2 tests PASS (RAN not skipped) + build clean.

- [ ] **Step 7: Commit**

```bash
git add api/internal/database/migrations/000017_saved_meals.up.sql api/internal/database/migrations/000017_saved_meals.down.sql api/internal/savedmeals/model.go api/internal/savedmeals/repository.go api/internal/savedmeals/repository_test.go
git commit -m "feat(savedmeals): tables, models, repository"
```

---

### Task 2: service + handler + routes (Go)

**Files:**
- Create: `api/internal/savedmeals/service.go`, `api/internal/savedmeals/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/savedmeals/service_test.go`, `api/internal/savedmeals/handler_test.go`

**Interfaces:**
- Consumes: `Repository` (Task 1); `nutrition.Repository`; `httpx`; `user.IDFromContext`.
- Produces: `SavedMealItemView`, `SavedMealView`, `SaveMealRequest`; `NewService(repo Repository, foods nutrition.Repository) *Service`; `Service.List/Create/Update/Delete`; `NewHandler(svc *Service) Handler`; `Handler.List/Create/Update/Delete`.

- [ ] **Step 1: Failing service test** — `api/internal/savedmeals/service_test.go`:

```go
package savedmeals

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func itemReq(id string, grams float64) struct {
	FoodItemID string  `json:"food_item_id"`
	Grams      float64 `json:"grams"`
} {
	return struct {
		FoodItemID string  `json:"food_item_id"`
		Grams      float64 `json:"grams"`
	}{FoodItemID: id, Grams: grams}
}

func TestCreateEnrichesAndTotals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100) // 100 kcal/100g, 10 protein/100g
	f2 := seedFood(t, db, 200)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	req := SaveMealRequest{Name: " My Bfast ", MealSlot: "breakfast"}
	req.Items = append(req.Items, itemReq(f1.ID.String(), 200), itemReq(f2.ID.String(), 100))
	v, err := svc.Create(context.Background(), userID, req)
	require.NoError(t, err)
	require.Equal(t, "My Bfast", v.Name) // trimmed
	require.Len(t, v.Items, 2)
	require.Equal(t, 200.0, v.Items[0].Kcal) // 100/100*200
	require.Equal(t, 400.0, v.Kcal)          // 200 + 200/100*100
}

func TestCreateValidates(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	bad := func(req SaveMealRequest) {
		_, err := svc.Create(context.Background(), userID, req)
		_, ok := httpx.IsValidation(err)
		require.True(t, ok)
	}
	r := SaveMealRequest{Name: "", MealSlot: "breakfast"}
	r.Items = append(r.Items, itemReq(f1.ID.String(), 100))
	bad(r) // empty name
	r = SaveMealRequest{Name: "x", MealSlot: "brunch"}
	r.Items = append(r.Items, itemReq(f1.ID.String(), 100))
	bad(r) // bad slot
	bad(SaveMealRequest{Name: "x", MealSlot: "lunch"}) // no items
	r = SaveMealRequest{Name: "x", MealSlot: "lunch"}
	r.Items = append(r.Items, itemReq(uuid.NewString(), 100))
	bad(r) // unknown food
}
```

- [ ] **Step 2: RED** — `cd api && TEST_DATABASE_URL="..." go test -race -p 1 ./internal/savedmeals/...` → FAIL (no NewService).

- [ ] **Step 3: Implement service** — `api/internal/savedmeals/service.go`:

```go
package savedmeals

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const (
	maxSavedMeals = 50
	maxNameLen    = 80
)

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

type SavedMealItemView struct {
	FoodItemID string  `json:"food_item_id"`
	Name       string  `json:"name"`
	Grams      float64 `json:"grams"`
	Kcal       float64 `json:"kcal"`
	ProteinG   float64 `json:"protein_g"`
	CarbsG     float64 `json:"carbs_g"`
	FatG       float64 `json:"fat_g"`
	FiberG     float64 `json:"fiber_g"`
}

type SavedMealView struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	MealSlot string              `json:"meal_slot"`
	Items    []SavedMealItemView `json:"items"`
	Kcal     float64             `json:"kcal"`
	ProteinG float64             `json:"protein_g"`
	CarbsG   float64             `json:"carbs_g"`
	FatG     float64             `json:"fat_g"`
	FiberG   float64             `json:"fiber_g"`
}

type SaveMealRequest struct {
	Name     string `json:"name"`
	MealSlot string `json:"meal_slot"`
	Items    []struct {
		FoodItemID string  `json:"food_item_id"`
		Grams      float64 `json:"grams"`
	} `json:"items"`
}

type Service struct {
	repo  Repository
	foods nutrition.Repository
}

func NewService(repo Repository, foods nutrition.Repository) *Service {
	return &Service{repo: repo, foods: foods}
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]SavedMealView, error) {
	meals, err := s.repo.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(meals) == 0 {
		return []SavedMealView{}, nil
	}
	ids := make([]uuid.UUID, len(meals))
	for i, m := range meals {
		ids[i] = m.ID
	}
	rows, err := s.repo.ItemsForMeals(ctx, ids)
	if err != nil {
		return nil, err
	}
	byMeal := map[uuid.UUID][]ItemRow{}
	for _, r := range rows {
		byMeal[r.SavedMealID] = append(byMeal[r.SavedMealID], r)
	}
	out := make([]SavedMealView, 0, len(meals))
	for _, m := range meals {
		v := SavedMealView{ID: m.ID.String(), Name: m.Name, MealSlot: m.MealSlot, Items: []SavedMealItemView{}}
		for _, it := range byMeal[m.ID] {
			f := it.Grams / 100.0
			iv := SavedMealItemView{
				FoodItemID: it.FoodItemID.String(), Name: it.Name, Grams: it.Grams,
				Kcal: it.KcalPer100g * f, ProteinG: it.ProteinPer100g * f, CarbsG: it.CarbsPer100g * f,
				FatG: it.FatPer100g * f, FiberG: it.FiberPer100g * f,
			}
			v.Items = append(v.Items, iv)
			v.Kcal += iv.Kcal
			v.ProteinG += iv.ProteinG
			v.CarbsG += iv.CarbsG
			v.FatG += iv.FatG
			v.FiberG += iv.FiberG
		}
		out = append(out, v)
	}
	return out, nil
}

// validate checks the request and resolves each food item, returning the parsed
// items and (for Create's response) the enriched view built from live food data.
func (s *Service) validate(ctx context.Context, req SaveMealRequest) (string, []SavedMealItem, []SavedMealItemView, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return "", nil, nil, httpx.ValidationError{Message: "name is required"}
	}
	if len(name) > maxNameLen {
		return "", nil, nil, httpx.ValidationError{Message: "name is too long"}
	}
	if !validMealSlots[req.MealSlot] {
		return "", nil, nil, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	if len(req.Items) == 0 {
		return "", nil, nil, httpx.ValidationError{Message: "at least one item is required"}
	}
	items := make([]SavedMealItem, 0, len(req.Items))
	views := make([]SavedMealItemView, 0, len(req.Items))
	for _, it := range req.Items {
		if it.Grams <= 0 {
			return "", nil, nil, httpx.ValidationError{Message: "grams must be positive"}
		}
		fid, err := uuid.Parse(it.FoodItemID)
		if err != nil {
			return "", nil, nil, httpx.ValidationError{Message: "invalid food_item_id"}
		}
		food, err := s.foods.GetByID(ctx, fid)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return "", nil, nil, httpx.ValidationError{Message: "unknown food_item_id"}
			}
			return "", nil, nil, fmt.Errorf("savedmeals: resolve food: %w", err)
		}
		items = append(items, SavedMealItem{FoodItemID: fid, Grams: it.Grams})
		f := it.Grams / 100.0
		views = append(views, SavedMealItemView{
			FoodItemID: fid.String(), Name: food.Name, Grams: it.Grams,
			Kcal: food.KcalPer100g * f, ProteinG: food.ProteinPer100g * f, CarbsG: food.CarbsPer100g * f,
			FatG: food.FatPer100g * f, FiberG: food.FiberPer100g * f,
		})
	}
	return name, items, views, nil
}

func viewFrom(id, name, slot string, itemViews []SavedMealItemView) SavedMealView {
	v := SavedMealView{ID: id, Name: name, MealSlot: slot, Items: itemViews}
	for _, iv := range itemViews {
		v.Kcal += iv.Kcal
		v.ProteinG += iv.ProteinG
		v.CarbsG += iv.CarbsG
		v.FatG += iv.FatG
		v.FiberG += iv.FiberG
	}
	return v
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, req SaveMealRequest) (SavedMealView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return SavedMealView{}, err
	}
	count, err := s.repo.CountForUser(ctx, userID)
	if err != nil {
		return SavedMealView{}, err
	}
	if count >= maxSavedMeals {
		return SavedMealView{}, httpx.ValidationError{Message: "saved-meal limit reached"}
	}
	m, err := s.repo.Create(ctx, SavedMeal{UserID: userID, Name: name, MealSlot: req.MealSlot}, items)
	if err != nil {
		return SavedMealView{}, err
	}
	return viewFrom(m.ID.String(), name, req.MealSlot, views), nil
}

func (s *Service) Update(ctx context.Context, userID, mealID uuid.UUID, req SaveMealRequest) (SavedMealView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return SavedMealView{}, err
	}
	if err := s.repo.Replace(ctx, userID, mealID, name, req.MealSlot, items); err != nil {
		return SavedMealView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	return viewFrom(mealID.String(), name, req.MealSlot, views), nil
}

func (s *Service) Delete(ctx context.Context, userID, mealID uuid.UUID) error {
	return s.repo.DeleteForUser(ctx, userID, mealID)
}
```

- [ ] **Step 4: Failing handler test** — `api/internal/savedmeals/handler_test.go`:

```go
package savedmeals

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func withUser(id uuid.UUID) gin.HandlerFunc {
	return func(c *gin.Context) { c.Set("user_id", id); c.Next() }
}

func TestHandlerCRUD(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.GET("/saved-meals", h.List)
	r.POST("/saved-meals", h.Create)
	r.PUT("/saved-meals/:id", h.Update)
	r.DELETE("/saved-meals/:id", h.Delete)

	body, _ := json.Marshal(map[string]any{"name": "Bfast", "meal_slot": "breakfast", "items": []map[string]any{{"food_item_id": f1.ID.String(), "grams": 100}}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/saved-meals", bytes.NewReader(body)))
	require.Equal(t, http.StatusCreated, w.Code)
	var created struct{ Data SavedMealView `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created.Data.ID

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/saved-meals", nil))
	require.Equal(t, http.StatusOK, w.Code)

	body, _ = json.Marshal(map[string]any{"name": "Renamed", "meal_slot": "lunch", "items": []map[string]any{{"food_item_id": f1.ID.String(), "grams": 150}}})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/saved-meals/"+id, bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/saved-meals/"+id, nil))
	require.Equal(t, http.StatusOK, w.Code)
}

func TestHandlerRejectsBadBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/saved-meals", h.Create)
	body, _ := json.Marshal(map[string]any{"name": "", "meal_slot": "breakfast", "items": []any{}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/saved-meals", bytes.NewReader(body)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}
```

- [ ] **Step 5: Implement handler** — `api/internal/savedmeals/handler.go`:

```go
package savedmeals

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) Handler { return Handler{svc: svc} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	meals, err := h.svc.List(c.Request.Context(), userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not list saved meals")
		return
	}
	httpx.OK(c, meals)
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req SaveMealRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed saved-meal body")
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
	mealID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid meal id")
		return
	}
	var req SaveMealRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed saved-meal body")
		return
	}
	v, err := h.svc.Update(c.Request.Context(), userID, mealID, req)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "saved meal not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, v)
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	mealID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid meal id")
		return
	}
	if err := h.svc.Delete(c.Request.Context(), userID, mealID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "saved meal not found")
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not delete saved meal")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}
```

- [ ] **Step 6: Register routes** — in `api/internal/server/router.go`, inside the `if deps.DB != nil && deps.Verifier != nil` block, after the pins wiring, add:

```go
		smHandler := savedmeals.NewHandler(savedmeals.NewService(savedmeals.NewRepository(deps.DB), foodRepo))
		v1.GET("/saved-meals", smHandler.List)
		v1.POST("/saved-meals", smHandler.Create)
		v1.PUT("/saved-meals/:id", smHandler.Update)
		v1.DELETE("/saved-meals/:id", smHandler.Delete)
```

Add the import `"github.com/tesserix/kora/api/internal/savedmeals"`.

- [ ] **Step 7: GREEN + build + vet**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable" go test -race -p 1 ./internal/savedmeals/... && go build ./... && go vet ./internal/server/...`
Expected: all savedmeals tests PASS (RAN not skipped) + build/vet clean.

- [ ] **Step 8: Commit**

```bash
git add api/internal/savedmeals/service.go api/internal/savedmeals/handler.go api/internal/savedmeals/service_test.go api/internal/savedmeals/handler_test.go api/internal/server/router.go
git commit -m "feat(savedmeals): service, handler, and /v1/saved-meals routes"
```

---

### Task 3: Mobile — types, hooks, logMeal retype

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (add `SavedMealItem`, `SavedMeal`, `LoggableMeal`)
- Modify: `apps/mobile/src/api/hooks.ts` (add `useSavedMeals`/`useCreateSavedMeal`/`useUpdateSavedMeal`/`useDeleteSavedMeal`)
- Modify: `apps/mobile/src/api/useInstantLog.ts` (retype `logMeal` param to `LoggableMeal`)
- Test: `apps/mobile/src/api/__tests__/savedMeals.test.tsx`

**Interfaces:**
- Produces: `type SavedMeal`, `type SavedMealItem`, `type LoggableMeal`; the four hooks.

- [ ] **Step 1: Types** — in `apps/mobile/src/api/types.ts` add:

```ts
export type SavedMealItem = {
  food_item_id: string;
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

export type SavedMeal = {
  id: string;
  name: string;
  meal_slot: string;
  items: SavedMealItem[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

// LoggableMeal is the minimal shape useInstantLog.logMeal needs; both MemoryMeal
// and SavedMeal satisfy it.
export type LoggableMeal = {
  name: string;
  meal_slot: string;
  items: { food_item_id: string; grams: number }[];
};
```

- [ ] **Step 2: Hooks** — in `apps/mobile/src/api/hooks.ts` add (import `SavedMeal` from `./types`). `SaveMealBody = { name: string; meal_slot: string; items: { food_item_id: string; grams: number }[] }`:

```ts
type SaveMealBody = { name: string; meal_slot: string; items: { food_item_id: string; grams: number }[] };

export function useSavedMeals() {
  return useQuery({
    queryKey: ["savedMeals"],
    queryFn: () => apiFetch("/v1/saved-meals") as Promise<SavedMeal[]>,
  });
}

export function useCreateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveMealBody) => apiFetch("/v1/saved-meals", { method: "POST", body: JSON.stringify(body) }) as Promise<SavedMeal>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}

export function useUpdateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SaveMealBody }) => apiFetch(`/v1/saved-meals/${id}`, { method: "PUT", body: JSON.stringify(body) }) as Promise<SavedMeal>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}

export function useDeleteSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/saved-meals/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}
```

- [ ] **Step 3: Retype `logMeal`** — in `apps/mobile/src/api/useInstantLog.ts`, change the `logMeal` parameter type from `MemoryMeal` to `LoggableMeal` (import `LoggableMeal` from `./types`; keep `logFood`'s `LoggableFood`). Signature:

```ts
export function useInstantLog(): { logFood: (f: LoggableFood) => void; logMeal: (m: LoggableMeal) => void } {
```

Body unchanged (it reads `m.meal_slot`, `m.items[].{food_item_id,grams}`, `m.name`). Existing callers pass `MemoryMeal` (satisfies `LoggableMeal`); `SavedMeal` also satisfies it.

- [ ] **Step 4: Failing hook test** — `apps/mobile/src/api/__tests__/savedMeals.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSavedMeals } from "../hooks";

const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useSavedMeals fetches /v1/saved-meals", async () => {
  mockApiFetch.mockResolvedValueOnce([{ id: "m1", name: "Bfast", meal_slot: "breakfast", items: [], kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }]);
  const { result } = renderHook(() => useSavedMeals(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/saved-meals");
  expect(result.current.data?.[0].name).toBe("Bfast");
});
```

> If the repo already has a hooks test harness (e.g. `src/api/__tests__/hooks.test.tsx`), mirror ITS wrapper/mock setup instead of the above (read it first).

- [ ] **Step 5: RED** — `cd apps/mobile && npm test -- --ci src/api/__tests__/savedMeals.test.tsx` → FAIL.

- [ ] **Step 6: (implementation is Steps 1-3)** — run GREEN + tsc:

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/api/__tests__/savedMeals.test.tsx`
Expected: PASS + tsc clean (tsc confirms the `logMeal` retype didn't break existing `logMeal` callers — YourUsualStrip, log.tsx).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/useInstantLog.ts apps/mobile/src/api/__tests__/savedMeals.test.tsx
git commit -m "feat(mobile): saved meals types and hooks"
```

---

### Task 4: Mobile — bookmark glyph + MealRow bookmark affordance

**Files:**
- Modify: `apps/mobile/src/components/Icon.tsx` (add `bookmark`/`bookmark-fill`)
- Modify: `apps/mobile/src/components/MealRow.tsx` (add `bookmarked`/`onBookmark`)
- Test: `apps/mobile/src/components/__tests__/MealRow.test.tsx` (extend)

- [ ] **Step 1: Icon glyph** — in `apps/mobile/src/components/Icon.tsx`: import `Bookmark` from `lucide-react-native` (next to `Star`); add to `SYMBOLS` `"bookmark": "bookmark", "bookmark-fill": "bookmark.fill"`; add to `MAP` `"bookmark": Bookmark, "bookmark-fill": Bookmark`.

- [ ] **Step 2: Extend the MealRow test** — add to `apps/mobile/src/components/__tests__/MealRow.test.tsx`:

```tsx
test("tapping the bookmark calls onBookmark and NOT the row onPress", async () => {
  const onPress = jest.fn();
  const onBookmark = jest.fn();
  const { getByLabelText } = await render(
    <MealRow name="Bfast" slot="Eggs · Oats" kcal={376} onPress={onPress} onBookmark={onBookmark} bookmarked={false} />,
  );
  fireEvent.press(getByLabelText("Save Bfast"));
  expect(onBookmark).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
});

test("no bookmark control when onBookmark is absent", async () => {
  const { queryByLabelText } = await render(<MealRow name="Bfast" slot="x" kcal={1} onPress={jest.fn()} />);
  expect(queryByLabelText("Save Bfast")).toBeNull();
  expect(queryByLabelText("Edit Bfast")).toBeNull();
});
```

- [ ] **Step 3: RED** — `cd apps/mobile && npm test -- --ci src/components/__tests__/MealRow.test.tsx` → FAIL (no bookmark).

- [ ] **Step 4: Implement** — in `apps/mobile/src/components/MealRow.tsx` add to `Props`: `bookmarked?: boolean; onBookmark?: () => void;`. After the star `Pressable` block (before `PressableScale` closes), add a sibling bookmark control (label "Save"/"Edit" so the a11y label distinguishes save vs edit by the `bookmarked` state):

```tsx
      {onBookmark ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bookmarked ? `Edit ${name}` : `Save ${name}`}
          hitSlop={10}
          onPress={onBookmark}
          style={{ paddingLeft: spacing.sm }}
        >
          <Icon name={bookmarked ? "bookmark-fill" : "bookmark"} size={20} color={bookmarked ? colors.accent : colors.tertiaryLabel} />
        </Pressable>
      ) : null}
```

(Reuse the `Pressable` import added in the pins work. A row uses at most one of `onPinToggle`/`onBookmark`.)

- [ ] **Step 5: GREEN + tsc** — `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/__tests__/MealRow.test.tsx` → PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/Icon.tsx apps/mobile/src/components/MealRow.tsx apps/mobile/src/components/__tests__/MealRow.test.tsx
git commit -m "feat(mobile): bookmark affordance on MealRow"
```

---

### Task 5: Mobile — SavedMealSheet editor + provider

**Files:**
- Create: `apps/mobile/src/components/meals/SavedMealSheet.tsx`
- Create: `apps/mobile/src/components/meals/SavedMealSheetProvider.tsx`
- Modify: `apps/mobile/app/_layout.tsx` (mount the provider)
- Test: `apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx`

**Interfaces:**
- Consumes: `Sheet`, `Button`, `AppText`, `Overline`, `Segmented`, `useTheme`; `useCreateSavedMeal`/`useUpdateSavedMeal`/`useDeleteSavedMeal` (Task 3); `MemoryMeal`/`SavedMeal` types.
- Produces: `SavedMealSheet` (controlled editor); `SavedMealSheetProvider`; `useSavedMealEditor(): { openCreate(m: MemoryMeal): void; openEdit(m: SavedMeal): void }`.

- [ ] **Step 1: Implement the sheet** — `apps/mobile/src/components/meals/SavedMealSheet.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Icon } from "@/components/Icon";
import { useCreateSavedMeal, useUpdateSavedMeal, useDeleteSavedMeal } from "@/api/hooks";
import type { MemoryMeal, SavedMeal } from "@/api/types";
import { useTheme } from "@/theme";

const SLOT_OPTIONS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

type EditItem = { food_item_id: string; name: string; grams: string };

// seed is either a usual meal to save (create) or an existing saved meal (edit).
export type Seed = { mode: "create"; meal: MemoryMeal } | { mode: "edit"; meal: SavedMeal };

interface Props {
  seed: Seed | null;
  onClose: () => void;
}

export function SavedMealSheet({ seed, onClose }: Props) {
  const { colors, spacing, radius, fonts } = useTheme();
  const createMeal = useCreateSavedMeal();
  const updateMeal = useUpdateSavedMeal();
  const deleteMeal = useDeleteSavedMeal();

  const [name, setName] = useState("");
  const [slot, setSlot] = useState("breakfast");
  const [items, setItems] = useState<EditItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setName(seed.meal.name);
    setSlot(seed.meal.meal_slot);
    setItems(seed.meal.items.map((i) => ({ food_item_id: i.food_item_id, name: i.name, grams: String(Math.round(i.grams)) })));
    setErr(null);
  }, [seed]);

  const removeItem = (idx: number) => setItems((cur) => cur.filter((_, i) => i !== idx));
  const setGrams = (idx: number, g: string) => setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, grams: g } : it)));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr("Enter a name."); return; }
    const parsed = items.map((it) => ({ food_item_id: it.food_item_id, grams: Number(it.grams) }));
    if (parsed.length === 0 || parsed.some((p) => !(p.grams > 0))) { setErr("Add at least one item with grams."); return; }
    const body = { name: trimmed, meal_slot: slot, items: parsed };
    if (seed?.mode === "edit") {
      updateMeal.mutate({ id: seed.meal.id, body }, { onSuccess: onClose });
    } else {
      createMeal.mutate(body, { onSuccess: onClose });
    }
  };

  const remove = () => {
    if (seed?.mode === "edit") deleteMeal.mutate(seed.meal.id, { onSuccess: onClose });
  };

  const pending = createMeal.isPending || updateMeal.isPending || deleteMeal.isPending;

  return (
    <Sheet visible={seed !== null} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{seed?.mode === "edit" ? "Edit saved meal" : "Save meal"}</Overline>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Meal name"
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel="Meal name"
          style={{ fontSize: 20, color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, marginTop: spacing.md }}
        />
        <View style={{ marginTop: spacing.md }}>
          <Segmented options={SLOT_OPTIONS} value={slot} onChange={setSlot} />
        </View>
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          {items.map((it, idx) => (
            <View key={it.food_item_id} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <AppText style={{ flex: 1 }}>{it.name}</AppText>
              <TextInput
                value={it.grams}
                onChangeText={(g) => setGrams(idx, g)}
                keyboardType="decimal-pad"
                accessibilityLabel={`${it.name} grams`}
                style={{ width: 72, textAlign: "right", color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, fontFamily: fonts.mono }}
              />
              <AppText muted>g</AppText>
              <Pressable accessibilityLabel={`Remove ${it.name}`} hitSlop={8} onPress={() => removeItem(idx)}>
                <Icon name="minus" size={20} color={colors.destructive} />
              </Pressable>
            </View>
          ))}
        </View>
        {err ? <AppText style={{ color: colors.destructive, marginTop: spacing.sm }}>{err}</AppText> : null}
        <View style={{ marginTop: spacing.lg }}>
          <Button title="Save" onPress={save} disabled={pending} />
        </View>
        {seed?.mode === "edit" ? (
          <Pressable onPress={remove} disabled={pending} style={{ marginTop: spacing.md, alignItems: "center" }}>
            <AppText style={{ color: colors.destructive }}>Delete saved meal</AppText>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
```

> Confirm `useTheme()` exposes `fonts.mono` (WeightLogSheet uses it). If not, drop the `fontFamily` line.

- [ ] **Step 2: Implement the provider** — `apps/mobile/src/components/meals/SavedMealSheetProvider.tsx`:

```tsx
import { createContext, useContext, useState, type ReactNode } from "react";
import { SavedMealSheet, type Seed } from "./SavedMealSheet";
import type { MemoryMeal, SavedMeal } from "@/api/types";

type Editor = { openCreate: (m: MemoryMeal) => void; openEdit: (m: SavedMeal) => void };

const Ctx = createContext<Editor>({ openCreate: () => {}, openEdit: () => {} });

export function useSavedMealEditor() {
  return useContext(Ctx);
}

export function SavedMealSheetProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState<Seed | null>(null);
  const openCreate = (m: MemoryMeal) => setSeed({ mode: "create", meal: m });
  const openEdit = (m: SavedMeal) => setSeed({ mode: "edit", meal: m });
  return (
    <Ctx.Provider value={{ openCreate, openEdit }}>
      {children}
      <SavedMealSheet seed={seed} onClose={() => setSeed(null)} />
    </Ctx.Provider>
  );
}
```

- [ ] **Step 3: Mount the provider** — in `apps/mobile/app/_layout.tsx`, import `SavedMealSheetProvider` and wrap the `<Stack>` (inside `<ToastProvider>`):

```tsx
import { SavedMealSheetProvider } from "@/components/meals/SavedMealSheetProvider";
// ...
          <ToastProvider>
            <SavedMealSheetProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="meal" options={{ presentation: "transparentModal", animation: "fade" }} />
                <Stack.Screen name="capture" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
              </Stack>
            </SavedMealSheetProvider>
          </ToastProvider>
```

- [ ] **Step 4: Write the failing sheet test** — `apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/api/hooks", () => ({
  useCreateSavedMeal: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateSavedMeal: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteSavedMeal: () => ({ mutate: mockDelete, isPending: false }),
}));
jest.mock("@/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? children : null) }));

import { SavedMealSheet } from "../SavedMealSheet";

const usual = {
  id: "u1", name: "Eggs & Oats", meal_slot: "breakfast",
  items: [
    { food_item_id: "f1", name: "Eggs", meal_slot: "breakfast", grams: 100, kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    { food_item_id: "f2", name: "Oats", meal_slot: "breakfast", grams: 60, kcal: 230, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  ],
  kcal: 373, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 5, last_logged_at: "2026-07-28T00:00:00Z",
};

beforeEach(() => { mockCreate.mockReset(); mockUpdate.mockReset(); mockDelete.mockReset(); });

test("create-seed prefills name + items, removing one and saving calls create with the kept item", async () => {
  const { getByText, getByLabelText, getByDisplayValue } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  getByDisplayValue("Eggs & Oats"); // name prefilled
  fireEvent.press(getByLabelText("Remove Oats")); // drop one item
  fireEvent.press(getByText("Save"));
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Eggs & Oats", meal_slot: "breakfast", items: [{ food_item_id: "f1", grams: 100 }] }),
    expect.any(Object),
  );
});

test("empty name blocks save", async () => {
  const { getByText, getByLabelText } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  fireEvent.changeText(getByLabelText("Meal name"), "   ");
  fireEvent.press(getByText("Save"));
  expect(mockCreate).not.toHaveBeenCalled();
  getByText("Enter a name.");
});

test("edit-seed shows Delete which calls delete", async () => {
  const saved = { id: "s1", name: "My Bfast", meal_slot: "lunch", items: [{ food_item_id: "f1", name: "Eggs", grams: 120, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }], kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const { getByText } = await render(<SavedMealSheet seed={{ mode: "edit", meal: saved as any }} onClose={jest.fn()} />);
  fireEvent.press(getByText("Delete saved meal"));
  expect(mockDelete).toHaveBeenCalledWith("s1", expect.any(Object));
});
```

- [ ] **Step 5: RED then GREEN** — `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/meals/__tests__/SavedMealSheet.test.tsx`. RED before the component exists (it does after Step 1), so expect GREEN (3) + tsc clean. If jest can't render `Segmented` (reanimated), mock it minimally: `jest.mock("@/components/Segmented", () => ({ Segmented: () => null }))`.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/meals/SavedMealSheet.tsx apps/mobile/src/components/meals/SavedMealSheetProvider.tsx "apps/mobile/app/_layout.tsx" apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx
git commit -m "feat(mobile): saved meal editor sheet + provider"
```

---

### Task 6: Mobile — Log "Saved" tab + bookmark on usual meals

**Files:**
- Modify: `apps/mobile/app/log.tsx`
- Test: `apps/mobile/app/__tests__/log.test.tsx` (extend)

- [ ] **Step 1: Wire it in** — in `apps/mobile/app/log.tsx`:
  1. Prepend `{ key: "saved", label: "Saved" }` to `MEMORY_TAB_OPTIONS` (first, before "pinned"). Widen `memTab` type to include `"saved"`; default stays `"recents"`.
  2. Add `const savedMeals = useSavedMeals();` (import from `@/api/hooks`) and `const { openCreate, openEdit } = useSavedMealEditor();` (import from `@/components/meals/SavedMealSheetProvider`).
  3. Add a `memTab === "saved"` branch FIRST in the tab-body conditional:

```tsx
              ) : memTab === "saved" ? (
                (savedMeals.data ?? []).length > 0 ? (
                  <GroupedSection elevated>
                    {(savedMeals.data ?? []).map((m) => {
                      const fv = foodVisual(m.name);
                      return (
                        <MealRow
                          key={m.id}
                          name={m.name}
                          slot={m.items.map((i) => i.name).join(" · ")}
                          kcal={m.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => logMeal(m)}
                          bookmarked
                          onBookmark={() => openEdit(m)}
                          accessibilityLabel={m.name}
                        />
                      );
                    })}
                  </GroupedSection>
                ) : (
                  <AppText muted>Save a usual meal to see it here.</AppText>
                )
```

  4. In the `usual_meals` branch's `MealRow`, add `onBookmark={() => openCreate(m)}` (so usual meals get a Save bookmark).

- [ ] **Step 2: Extend the test** — in `apps/mobile/app/__tests__/log.test.tsx`, mock `useSavedMeals` (return one saved meal) and `@/components/meals/SavedMealSheetProvider`'s `useSavedMealEditor` (`{ openCreate: jest.fn(), openEdit: jest.fn() }`), mirroring the existing mock structure. Add one test: press the "Saved" tab, assert the saved meal name renders. (Read the file first; match its `mock`-prefixed conventions.)

- [ ] **Step 3: GREEN + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci "app/__tests__/log.test.tsx"`
Expected: PASS + tsc clean. Report any pre-existing assertions adjusted.

- [ ] **Step 4: Commit**

```bash
git add "apps/mobile/app/log.tsx" "apps/mobile/app/__tests__/log.test.tsx"
git commit -m "feat(mobile): Saved tab and bookmark on usual meals in Log"
```

---

### Task 7: Mobile — SavedMealsStrip on Home

**Files:**
- Create: `apps/mobile/src/components/home/SavedMealsStrip.tsx`
- Modify: `apps/mobile/app/(tabs)/index.tsx` (mount above `<PinnedStrip />`)
- Test: `apps/mobile/src/components/home/__tests__/SavedMealsStrip.test.tsx`; update `app/(tabs)/__tests__/index.test.tsx` if needed

- [ ] **Step 1: Failing test** — `apps/mobile/src/components/home/__tests__/SavedMealsStrip.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";

const mockLogMeal = jest.fn();
const mockOpenEdit = jest.fn();
let mockSaved: { data?: unknown; isLoading?: boolean; isError?: boolean } = { data: [] };

jest.mock("@/api/hooks", () => ({ useSavedMeals: () => mockSaved }));
jest.mock("@/api/useInstantLog", () => ({ useInstantLog: () => ({ logMeal: mockLogMeal, logFood: jest.fn() }) }));
jest.mock("@/components/meals/SavedMealSheetProvider", () => ({ useSavedMealEditor: () => ({ openCreate: jest.fn(), openEdit: mockOpenEdit }) }));

import { SavedMealsStrip } from "../SavedMealsStrip";

beforeEach(() => { mockSaved = { data: [] }; });

test("null when there are no saved meals", async () => {
  const { toJSON } = await render(<SavedMealsStrip />);
  expect(toJSON()).toBeNull();
});

test("renders a Saved section with the meals", async () => {
  mockSaved = { data: [{ id: "s1", name: "My Bfast", meal_slot: "breakfast", items: [{ food_item_id: "f1", name: "Eggs", grams: 100, kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }], kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }] };
  const { getByText } = await render(<SavedMealsStrip />);
  getByText("Saved");
  getByText("My Bfast");
});
```

- [ ] **Step 2: RED** — `cd apps/mobile && npm test -- --ci src/components/home/__tests__/SavedMealsStrip.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — `apps/mobile/src/components/home/SavedMealsStrip.tsx`:

```tsx
import { View } from "react-native";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { useSavedMeals } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// SavedMealsStrip surfaces the user's saved meals on Home for one-tap logging.
// Renders nothing while loading/error/empty.
export function SavedMealsStrip() {
  const saved = useSavedMeals();
  const { logMeal } = useInstantLog();
  const { openEdit } = useSavedMealEditor();

  if (saved.isLoading || saved.isError) return null;
  const data = saved.data ?? [];
  if (data.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <Overline style={{ marginBottom: 8 }}>Saved</Overline>
      <GroupedSection elevated>
        {data.map((m) => {
          const fv = foodVisual(m.name);
          return (
            <MealRow
              key={m.id}
              name={m.name}
              slot={m.items.map((i) => i.name).join(" · ")}
              kcal={m.kcal}
              iconName={fv.icon}
              tint={hslToHex(fv.hue, 0.5, 0.5)}
              onPress={() => logMeal(m)}
              bookmarked
              onBookmark={() => openEdit(m)}
              accessibilityLabel={m.name}
            />
          );
        })}
      </GroupedSection>
    </View>
  );
}
```

> Match `foodVisual`/`hslToHex` import paths to `PinnedStrip.tsx`/`YourUsualStrip.tsx`.

- [ ] **Step 4: Mount on Home** — in `apps/mobile/app/(tabs)/index.tsx`, import `SavedMealsStrip` and render it immediately ABOVE `<PinnedStrip />`:

```tsx
      {/* meals */}
      <SavedMealsStrip />
      <PinnedStrip />
      <YourUsualStrip />
```

- [ ] **Step 5: GREEN + tsc, then Home test**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/home/__tests__/SavedMealsStrip.test.tsx`
Expected: PASS (2) + tsc clean.

Then `npm test -- --ci "app/(tabs)/__tests__/index.test.tsx"`. If it fails because `SavedMealsStrip` calls `useSavedMeals`/`useSavedMealEditor` unmocked, add `useSavedMeals: () => ({ data: [] })` to that test's `@/api/hooks` mock and mock `@/components/meals/SavedMealSheetProvider` `useSavedMealEditor: () => ({ openCreate: jest.fn(), openEdit: jest.fn() })`, so the strip renders null. Report the change.

- [ ] **Step 6: Full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: all PASS + tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/home/SavedMealsStrip.tsx "apps/mobile/app/(tabs)/index.tsx" apps/mobile/src/components/home/__tests__/SavedMealsStrip.test.tsx
git commit -m "feat(mobile): Saved meals strip on Home"
```

(Include `app/(tabs)/__tests__/index.test.tsx` if you changed it.)

---

## Device verification (controller, after all tasks)

Restart API (rebuild + run) + Metro. On the sim (demo user): Log → **Usual meals** tab → tap a usual meal's **bookmark** → the editor opens seeded with its name + items → rename it, remove an item, change a portion → **Save** → it appears in the **Saved** tab and the Home **Saved** strip → tap it to log (Undo toast) → tap its bookmark → editor re-opens (edit mode) → **Delete** removes it from both surfaces. Confirm the bookmark tap never logs, saved meals persist across reload, and are user-scoped.

## Out of scope (later)

Adding foods / build-from-scratch (food-search picker), reordering items, per-log custom names, sharing, a cap UI.
