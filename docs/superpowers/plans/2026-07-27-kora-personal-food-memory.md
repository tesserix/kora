# Personal Food Memory (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user re-log the foods and meals they usually eat in one tap, derived automatically from their own log history.

**Architecture:** A new Go `memory` package computes Recents / Frequent / Usual-meals purely from the user's `food_logs` (Approach A — on-read, no new tables/jobs). A new atomic `POST /v1/logs/batch` logs a whole usual meal. The mobile Log screen gains a `Recents · Frequent · Usual meals` library above search, with instant-log + a new Undo toast.

**Tech Stack:** Go 1.26 + Gin + GORM (backend); Expo/React Native + TypeScript + React Query + Reanimated (mobile). Spec: `docs/superpowers/specs/2026-07-27-kora-personal-food-memory-design.md`.

## Global Constraints

- **No fabricated numbers:** all macros are computed server-side as `FoodItem` per-100g × grams. The memory read path uses the macros already stored on each `food_log` row (which equal item×grams, computed at log time). The batch write path recomputes from `food_item_id` + grams exactly like `foodlog.Service.Create`. The client never sends macros.
- **User isolation:** every query filtered by `user_id`.
- **Timezone:** day grouping uses the user's `*time.Location` from `gosharedmw`/handler context (same source `foodlog` uses — `LocFromContext`).
- **Determinism:** all ranking/clustering has explicit tie-breaks and is a pure function of `(logs, loc)` → table-testable.
- **Mobile tokens-only:** colors from `useTheme()` `colors.*`; no hex literals in screens/components (palette files excepted).
- **Testing:** Go — `cd api && go test -race -p 1 ./internal/<pkg>/...` (foreground). Mobile — `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` (foreground). RNTL v14 → `await render(...)`.
- **Git:** branch `food-memory` (already created off `main`). Single-line conventional commits, no signature, never `git add -A` (stage named files only; untracked `ios/`, `.superpowers/`, `docs/` exist).

---

### Task 1: `foodlog` window query for memory

**Files:**
- Modify: `api/internal/foodlog/repository.go` (add method)
- Test: `api/internal/foodlog/repository_test.go` (add test)

**Interfaces:**
- Produces: `func (r Repository) ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]FoodLog, error)` — all of the user's logs with `logged_at >= since`, `food_item_id IS NOT NULL`, ordered `logged_at ASC`.

- [ ] **Step 1: Write the failing test** — append to `repository_test.go`:

```go
func TestListForUserSince(t *testing.T) {
	db := testDB(t) // same helper the other repository_test.go tests use
	repo := NewRepository(db)
	u := seedUser(t, db)          // same helper used elsewhere in this test file
	item := seedFoodItem(t, db)   // same helper used elsewhere in this test file
	ctx := context.Background()

	now := time.Now()
	// in-window
	_, err := repo.Create(ctx, FoodLog{UserID: u.ID, FoodItemID: &item.ID, LoggedAt: now.Add(-2 * 24 * time.Hour), MealSlot: "breakfast", QuantityGrams: 60, Kcal: 100})
	if err != nil { t.Fatal(err) }
	// out-of-window
	_, err = repo.Create(ctx, FoodLog{UserID: u.ID, FoodItemID: &item.ID, LoggedAt: now.Add(-200 * 24 * time.Hour), MealSlot: "breakfast", QuantityGrams: 60, Kcal: 100})
	if err != nil { t.Fatal(err) }

	got, err := repo.ListForUserSince(ctx, u.ID, now.Add(-90*24*time.Hour))
	if err != nil { t.Fatal(err) }
	if len(got) != 1 {
		t.Fatalf("want 1 in-window log, got %d", len(got))
	}
}
```

(Match the exact user/item seed helpers already present in `repository_test.go`; read the top of that file first and reuse them verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test -race -p 1 ./internal/foodlog/ -run TestListForUserSince`
Expected: FAIL — `repo.ListForUserSince undefined`.

- [ ] **Step 3: Implement the method** — add to `repository.go` (mirror the query style of `ListByUserAndDay`):

```go
// ListForUserSince returns the user's logs at or after `since` that resolved to
// a food item (food_item_id NOT NULL), oldest first. Used by the memory engine.
func (r Repository) ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]FoodLog, error) {
	var logs []FoodLog
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND food_item_id IS NOT NULL AND logged_at >= ?", userID, since).
		Order("logged_at ASC").
		Find(&logs).Error
	return logs, err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test -race -p 1 ./internal/foodlog/ -run TestListForUserSince`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog/repository.go api/internal/foodlog/repository_test.go
git commit -m "feat(foodlog): ListForUserSince window query for food memory"
```

---

### Task 2: Atomic batch logging (`POST /v1/logs/batch`)

**Files:**
- Modify: `api/internal/foodlog/service.go` (add `CreateBatch`)
- Modify: `api/internal/foodlog/handler.go` (add `CreateBatch` handler)
- Modify: `api/internal/server/router.go:78-83` (register route)
- Test: `api/internal/foodlog/service_test.go`, `api/internal/foodlog/handler_test.go` (add tests)

**Interfaces:**
- Consumes: existing `Service` with `foods` repo and the per-item macro math from `Create` (`item.KcalPer100g * grams/100`, etc.).
- Produces:
  - `type BatchItem struct { FoodItemID uuid.UUID; QuantityGrams float64 }`
  - `type CreateBatchRequest struct { LoggedAt time.Time; MealSlot string; Items []BatchItem }`
  - `func (s Service) CreateBatch(ctx context.Context, userID uuid.UUID, req CreateBatchRequest) ([]FoodLog, error)` — creates one `FoodLog` per item in a single transaction, macros recomputed server-side; rolls back if any item is unresolvable.
  - Handler `func (h Handler) CreateBatch(c *gin.Context)` bound at `POST /v1/logs/batch`.

- [ ] **Step 1: Write the failing service test** — append to `service_test.go` (reuse this file's existing `newService`/seed helpers verbatim):

```go
func TestCreateBatch(t *testing.T) {
	svc, db := newService(t)          // reuse existing helper
	u := seedUser(t, db)
	item := seedFoodItem(t, db)       // has KcalPer100g etc.
	ctx := context.Background()

	logs, err := svc.CreateBatch(ctx, u.ID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 200}},
	})
	if err != nil { t.Fatal(err) }
	if len(logs) != 1 { t.Fatalf("want 1 log, got %d", len(logs)) }
	want := item.KcalPer100g * 2.0
	if logs[0].Kcal != want {
		t.Fatalf("kcal not server-computed: want %v got %v", want, logs[0].Kcal)
	}
}

func TestCreateBatchRejectsEmpty(t *testing.T) {
	svc, db := newService(t)
	u := seedUser(t, db)
	_, err := svc.CreateBatch(context.Background(), u.ID, CreateBatchRequest{LoggedAt: time.Now(), MealSlot: "breakfast", Items: nil})
	if err == nil { t.Fatal("want validation error on empty items") }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && go test -race -p 1 ./internal/foodlog/ -run TestCreateBatch`
Expected: FAIL — `svc.CreateBatch undefined`.

- [ ] **Step 3: Implement `CreateBatch`** in `service.go` (reuse the exact macro math from `Create`; wrap in a GORM transaction):

```go
type BatchItem struct {
	FoodItemID    uuid.UUID `json:"food_item_id"`
	QuantityGrams float64   `json:"quantity_grams"`
}

type CreateBatchRequest struct {
	LoggedAt time.Time   `json:"logged_at"`
	MealSlot string      `json:"meal_slot"`
	Items    []BatchItem `json:"items"`
}

// CreateBatch logs several foods as one meal in a single transaction. Macros are
// recomputed server-side per item (item per-100g × grams) — identical to Create —
// so no client-supplied nutrition is ever trusted. All-or-nothing: any unresolvable
// item rolls the whole batch back.
func (s Service) CreateBatch(ctx context.Context, userID uuid.UUID, req CreateBatchRequest) ([]FoodLog, error) {
	if len(req.Items) == 0 {
		return nil, httpx.ValidationError{Message: "items must not be empty"}
	}
	if !validMealSlot(req.MealSlot) { // reuse the existing slot validator used by Create
		return nil, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	out := make([]FoodLog, 0, len(req.Items))
	err := s.repo.Transaction(ctx, func(txRepo Repository) error { // see Step 3b
		for _, it := range req.Items {
			if it.QuantityGrams <= 0 {
				return httpx.ValidationError{Message: "quantity_grams must be positive"}
			}
			item, err := s.foods.GetByID(ctx, it.FoodItemID)
			if err != nil {
				return httpx.ValidationError{Message: "unknown food_item_id"}
			}
			f := it.QuantityGrams / 100.0
			created, err := txRepo.Create(ctx, FoodLog{
				UserID: userID, FoodItemID: &it.FoodItemID, LoggedAt: loggedAt,
				MealSlot: req.MealSlot, Source: "memory", Description: item.Name,
				QuantityGrams: it.QuantityGrams,
				Kcal: item.KcalPer100g * f, ProteinG: item.ProteinPer100g * f,
				CarbsG: item.CarbsPer100g * f, FatG: item.FatPer100g * f,
				FiberG: item.FiberPer100g * f, Provenance: item.Provenance,
			})
			if err != nil {
				return err
			}
			out = append(out, created)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
```

- [ ] **Step 3b: Add the transaction helper** to `repository.go` if not present:

```go
// Transaction runs fn inside a DB transaction with a repository bound to the tx.
func (r Repository) Transaction(ctx context.Context, fn func(Repository) error) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(Repository{db: tx})
	})
}
```

(If `Create` reads the slot/validation differently, match it. Read `Create` in `service.go` and reuse its exact `validMealSlot`/slot-constant helper; do not duplicate the slot list.)

- [ ] **Step 4: Run service tests to verify they pass**

Run: `cd api && go test -race -p 1 ./internal/foodlog/ -run TestCreateBatch`
Expected: PASS (both).

- [ ] **Step 5: Add the handler** in `handler.go` (mirror `Create`'s parse → call → respond shape; use `resolveUserID`/context helpers exactly as `Create` does):

```go
func (h Handler) CreateBatch(c *gin.Context) {
	userID, ok := userIDFromContext(c) // use whatever helper Create uses
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req CreateBatchRequest // same package as the handler
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_request", "invalid body")
		return
	}
	logs, err := h.svc.CreateBatch(c.Request.Context(), userID, req)
	if err != nil {
		httpx.RespondServiceError(c, err) // same error mapper Create uses (400 validation / 500 infra)
		return
	}
	c.JSON(http.StatusCreated, logs)
}
```

(Read `Create` in `handler.go` first and copy its **exact** user-id extraction helper — `userIDFromContext` above is a placeholder for whatever `Create` actually calls — and its error-mapping calls. Likewise in Task 2 Step 3, confirm the `Service` struct's log-repo field name from `NewService`/`Create` — `s.repo` above stands in for the real field — and the `foods` field is `s.foods` as `Create` uses it.)

- [ ] **Step 6: Register the route** — in `router.go`, after line 83 (`v1.POST("/logs/:id/repeat", ...)`):

```go
v1.POST("/logs/batch", logHandler.CreateBatch)
```

- [ ] **Step 7: Write + run the handler test** — append to `handler_test.go` (mirror the existing `POST /v1/logs` handler test; register `r.POST("/v1/logs/batch", h.CreateBatch)`, post `{"meal_slot":"breakfast","items":[{"food_item_id":"<id>","quantity_grams":200}]}`, assert 201 and one returned log with server-computed kcal). Then:

Run: `cd api && go test -race -p 1 ./internal/foodlog/`
Expected: PASS (all foodlog tests).

- [ ] **Step 8: Commit**

```bash
git add api/internal/foodlog/service.go api/internal/foodlog/handler.go api/internal/foodlog/repository.go api/internal/foodlog/service_test.go api/internal/foodlog/handler_test.go api/internal/server/router.go
git commit -m "feat(foodlog): atomic POST /v1/logs/batch for meal logging"
```

---

### Task 3: `memory` package — types + Recents + Frequent

**Files:**
- Create: `api/internal/memory/model.go`
- Create: `api/internal/memory/service.go`
- Test: `api/internal/memory/service_test.go`

**Interfaces:**
- Consumes: `foodlog.FoodLog` (fields `FoodItemID *uuid.UUID`, `LoggedAt`, `MealSlot`, `Description`, `QuantityGrams`, `Kcal`, `ProteinG`, `CarbsG`, `FatG`, `FiberG`).
- Produces:
  - Types `Food`, `Meal`, `Memory` (see model.go below).
  - `type LogSource interface { ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error) }` (satisfied by `foodlog.Repository`).
  - `func NewService(logs LogSource) Service`
  - `func (s Service) Build(ctx, userID uuid.UUID, now time.Time, loc *time.Location) (Memory, error)`
  - Pure helpers `recents([]foodlog.FoodLog) []Food` and `frequent([]foodlog.FoodLog) []Food` (used by Task 4's `usualMeals` too).

- [ ] **Step 1: Create `model.go`**

```go
// Package memory derives one-tap re-log suggestions from a user's food-log history.
package memory

import "time"

type Food struct {
	FoodItemID   string    `json:"food_item_id"`
	Name         string    `json:"name"`
	MealSlot     string    `json:"meal_slot"`
	Grams        float64   `json:"grams"`
	Kcal         float64   `json:"kcal"`
	ProteinG     float64   `json:"protein_g"`
	CarbsG       float64   `json:"carbs_g"`
	FatG         float64   `json:"fat_g"`
	FiberG       float64   `json:"fiber_g"`
	Count        int       `json:"count"`
	LastLoggedAt time.Time `json:"last_logged_at"`
}

type Meal struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MealSlot     string    `json:"meal_slot"`
	Items        []Food    `json:"items"`
	Kcal         float64   `json:"kcal"`
	ProteinG     float64   `json:"protein_g"`
	CarbsG       float64   `json:"carbs_g"`
	FatG         float64   `json:"fat_g"`
	FiberG       float64   `json:"fiber_g"`
	Count        int       `json:"count"`
	LastLoggedAt time.Time `json:"last_logged_at"`
}

type Memory struct {
	Recents    []Food `json:"recents"`
	Frequent   []Food `json:"frequent"`
	UsualMeals []Meal `json:"usual_meals"`
}
```

- [ ] **Step 2: Write failing tests** — `service_test.go` (pure, no DB — build `[]foodlog.FoodLog` slices directly):

```go
package memory

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

func fid(s string) *uuid.UUID { u := uuid.MustParse(s); return &u }

func log(itemID, name, slot string, grams, kcal float64, at time.Time) foodlog.FoodLog {
	return foodlog.FoodLog{FoodItemID: fid(itemID), Description: name, MealSlot: slot, QuantityGrams: grams, Kcal: kcal, LoggedAt: at}
}

const eggs = "11111111-1111-1111-1111-111111111111"
const oats = "22222222-2222-2222-2222-222222222222"

func TestRecentsMostRecentDistinctFoods(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	logs := []foodlog.FoodLog{
		log(eggs, "Eggs", "breakfast", 100, 155, base),
		log(oats, "Oats", "breakfast", 60, 230, base.Add(24*time.Hour)),
		log(eggs, "Eggs", "breakfast", 120, 186, base.Add(48*time.Hour)), // newer eggs
	}
	got := recents(logs)
	if len(got) != 2 { t.Fatalf("want 2 distinct, got %d", len(got)) }
	if got[0].FoodItemID != eggs { t.Fatalf("most-recent should be eggs, got %s", got[0].FoodItemID) }
	if got[0].Grams != 120 { t.Fatalf("recents portion should be the most-recent (120), got %v", got[0].Grams) }
}

func TestFrequentGatesAndRanksByCountThenRecency(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	logs := []foodlog.FoodLog{
		log(eggs, "Eggs", "breakfast", 100, 155, base),
		log(eggs, "Eggs", "breakfast", 100, 155, base.Add(24*time.Hour)),
		log(eggs, "Eggs", "breakfast", 120, 186, base.Add(48*time.Hour)),
		log(oats, "Oats", "breakfast", 60, 230, base.Add(72*time.Hour)), // count 1 → excluded (min 2)
	}
	got := frequent(logs)
	if len(got) != 1 { t.Fatalf("want only eggs (count>=2), got %d", len(got)) }
	if got[0].Count != 3 { t.Fatalf("eggs count want 3 got %d", got[0].Count) }
	if got[0].Grams != 100 { t.Fatalf("frequent portion should be the mode (100), got %v", got[0].Grams) }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd api && go test -race -p 1 ./internal/memory/`
Expected: FAIL — `recents`/`frequent` undefined.

- [ ] **Step 4: Implement `service.go`** (constants, `LogSource`, `Service`, `Build`, and the pure `recents`/`frequent`):

```go
package memory

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

const (
	windowDays       = 90
	recentsLimit     = 20
	frequentMinCount = 2
	frequentLimit    = 20
)

type LogSource interface {
	ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error)
}

type Service struct{ logs LogSource }

func NewService(logs LogSource) Service { return Service{logs: logs} }

func (s Service) Build(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (Memory, error) {
	since := now.Add(-windowDays * 24 * time.Hour)
	logs, err := s.logs.ListForUserSince(ctx, userID, since)
	if err != nil {
		return Memory{}, err
	}
	return Memory{
		Recents:    recents(logs),
		Frequent:   frequent(logs),
		UsualMeals: usualMeals(logs, loc), // implemented in Task 4
	}, nil
}

func foodFrom(l foodlog.FoodLog) Food {
	return Food{
		FoodItemID: l.FoodItemID.String(), Name: l.Description, MealSlot: l.MealSlot,
		Grams: l.QuantityGrams, Kcal: l.Kcal, ProteinG: l.ProteinG, CarbsG: l.CarbsG,
		FatG: l.FatG, FiberG: l.FiberG, LastLoggedAt: l.LoggedAt,
	}
}

// recents: one entry per food item, represented by its most-recent log.
func recents(logs []foodlog.FoodLog) []Food {
	latest := map[string]foodlog.FoodLog{}
	for _, l := range logs { // logs arrive oldest-first, so last write wins = most recent
		latest[l.FoodItemID.String()] = l
	}
	out := make([]Food, 0, len(latest))
	for _, l := range latest {
		out = append(out, foodFrom(l))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > recentsLimit {
		out = out[:recentsLimit]
	}
	return out
}

// frequent: foods logged >= frequentMinCount times, ranked count → recency → name,
// carrying the user's mode portion (tie-break: most-recent occurrence of the mode).
func frequent(logs []foodlog.FoodLog) []Food {
	type agg struct {
		count    int
		last     foodlog.FoodLog
		portions map[float64]int
		portLast map[float64]time.Time
	}
	m := map[string]*agg{}
	for _, l := range logs {
		k := l.FoodItemID.String()
		a := m[k]
		if a == nil {
			a = &agg{portions: map[float64]int{}, portLast: map[float64]time.Time{}}
			m[k] = a
		}
		a.count++
		a.last = l // oldest-first → ends on most recent
		a.portions[l.QuantityGrams]++
		if l.LoggedAt.After(a.portLast[l.QuantityGrams]) {
			a.portLast[l.QuantityGrams] = l.LoggedAt
		}
	}
	out := make([]Food, 0, len(m))
	for _, a := range m {
		if a.count < frequentMinCount {
			continue
		}
		f := foodFrom(a.last)
		f.Count = a.count
		f.Grams = modePortion(a.portions, a.portLast)
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > frequentLimit {
		out = out[:frequentLimit]
	}
	return out
}

// modePortion returns the most-common grams; ties broken by most-recent use, then larger grams.
func modePortion(counts map[float64]int, last map[float64]time.Time) float64 {
	best := 0.0
	bestN := -1
	for g, n := range counts {
		if n > bestN ||
			(n == bestN && last[g].After(last[best])) ||
			(n == bestN && last[g].Equal(last[best]) && g > best) {
			best, bestN = g, n
		}
	}
	return best
}
```

(Note: `usualMeals` is referenced here but implemented in Task 4. To keep this task compiling and its tests runnable, add a temporary stub `func usualMeals(_ []foodlog.FoodLog, _ *time.Location) []Meal { return nil }` at the bottom of `service.go` now; Task 4 replaces its body.)

- [ ] **Step 5: Run to verify tests pass**

Run: `cd api && go test -race -p 1 ./internal/memory/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/memory/model.go api/internal/memory/service.go api/internal/memory/service_test.go
git commit -m "feat(memory): recents + frequent food ranking"
```

---

### Task 4: `memory` — Usual-meals clustering

**Files:**
- Modify: `api/internal/memory/service.go` (replace the `usualMeals` stub)
- Test: `api/internal/memory/service_test.go` (add tests)

**Interfaces:**
- Produces: real `func usualMeals(logs []foodlog.FoodLog, loc *time.Location) []Meal`.

- [ ] **Step 1: Write failing tests** — append to `service_test.go`:

```go
func TestUsualMealsRequiresRecurringMultiFoodSet(t *testing.T) {
	loc := time.UTC
	mk := func(day int, hm int) time.Time { return time.Date(2026, 7, day, hm, 0, 0, 0, time.UTC) }
	var logs []foodlog.FoodLog
	// eggs+oats breakfast on 3 distinct days → usual meal
	for _, d := range []int{1, 2, 3} {
		logs = append(logs,
			log(eggs, "Eggs", "breakfast", 100, 155, mk(d, 8)),
			log(oats, "Oats", "breakfast", 60, 230, mk(d, 8)),
		)
	}
	// a single-food breakfast on 3 days → NOT a usual meal (belongs in Frequent)
	for _, d := range []int{5, 6, 7} {
		logs = append(logs, log(eggs, "Eggs", "breakfast", 100, 155, mk(d, 8)))
	}
	got := usualMeals(logs, loc)
	if len(got) != 1 { t.Fatalf("want exactly one usual meal, got %d", len(got)) }
	if got[0].Count != 3 { t.Fatalf("want count 3, got %d", got[0].Count) }
	if len(got[0].Items) != 2 { t.Fatalf("want 2 component foods, got %d", len(got[0].Items)) }
	if got[0].Kcal != 385 { t.Fatalf("want summed kcal 385, got %v", got[0].Kcal) }
}

func TestUsualMealsBelowThresholdExcluded(t *testing.T) {
	loc := time.UTC
	mk := func(day int) time.Time { return time.Date(2026, 7, day, 8, 0, 0, 0, time.UTC) }
	var logs []foodlog.FoodLog
	for _, d := range []int{1, 2} { // only 2 days < 3
		logs = append(logs, log(eggs, "Eggs", "breakfast", 100, 155, mk(d)), log(oats, "Oats", "breakfast", 60, 230, mk(d)))
	}
	if got := usualMeals(logs, loc); len(got) != 0 {
		t.Fatalf("want 0 usual meals below threshold, got %d", len(got))
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && go test -race -p 1 ./internal/memory/ -run TestUsualMeals`
Expected: FAIL (stub returns nil → count/length asserts fail).

- [ ] **Step 3: Replace the `usualMeals` stub** in `service.go`:

```go
const (
	usualMealMinDays = 3
	usualMealsLimit  = 12
)

// usualMeals groups logs into meal instances by (local calendar day, meal_slot),
// fingerprints each instance by its SET of food ids, and surfaces fingerprints that
// recur on >= usualMealMinDays distinct days. Single-food instances are excluded.
func usualMeals(logs []foodlog.FoodLog, loc *time.Location) []Meal {
	if loc == nil {
		loc = time.UTC
	}
	// 1. bucket logs into meal instances keyed by day|slot
	type inst struct {
		items map[string]foodlog.FoodLog // most-recent log per food id in this instance
		day   string
		slot  string
	}
	instances := map[string]*inst{}
	for _, l := range logs {
		day := l.LoggedAt.In(loc).Format("2006-01-02")
		key := day + "|" + l.MealSlot
		in := instances[key]
		if in == nil {
			in = &inst{items: map[string]foodlog.FoodLog{}, day: day, slot: l.MealSlot}
			instances[key] = in
		}
		in.items[l.FoodItemID.String()] = l
	}
	// 2. fingerprint each multi-food instance by sorted food-id set
	type sig struct {
		slot  string
		days  map[string]bool
		last  time.Time
		items map[string]foodlog.FoodLog // representative log per food id (most recent across days)
	}
	sigs := map[string]*sig{}
	for _, in := range instances {
		if len(in.items) < 2 {
			continue
		}
		ids := make([]string, 0, len(in.items))
		for id := range in.items {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		fp := in.slot + ":" + strings.Join(ids, ",")
		s := sigs[fp]
		if s == nil {
			s = &sig{slot: in.slot, days: map[string]bool{}, items: map[string]foodlog.FoodLog{}}
			sigs[fp] = s
		}
		s.days[in.day] = true
		for id, l := range in.items {
			if l.LoggedAt.After(s.items[id].LoggedAt) {
				s.items[id] = l
			}
			if l.LoggedAt.After(s.last) {
				s.last = l.LoggedAt
			}
		}
	}
	// 3. keep fingerprints seen on >= usualMealMinDays days; build Meal
	out := make([]Meal, 0, len(sigs))
	for fp, s := range sigs {
		if len(s.days) < usualMealMinDays {
			continue
		}
		items := make([]Food, 0, len(s.items))
		for _, l := range s.items {
			items = append(items, foodFrom(l))
		}
		// components sorted by kcal desc → name asc (stable, and used for the name)
		sort.Slice(items, func(i, j int) bool {
			if items[i].Kcal != items[j].Kcal {
				return items[i].Kcal > items[j].Kcal
			}
			return items[i].Name < items[j].Name
		})
		m := Meal{ID: hashFingerprint(fp), MealSlot: s.slot, Items: items, Count: len(s.days), LastLoggedAt: s.last}
		for _, it := range items {
			m.Kcal += it.Kcal
			m.ProteinG += it.ProteinG
			m.CarbsG += it.CarbsG
			m.FatG += it.FatG
			m.FiberG += it.FiberG
		}
		m.Name = mealName(items)
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > usualMealsLimit {
		out = out[:usualMealsLimit]
	}
	return out
}

func hashFingerprint(fp string) string {
	sum := sha1.Sum([]byte(fp))
	return hex.EncodeToString(sum[:])
}

// mealName joins component names: all if <=3, else first two + " +N more".
func mealName(items []Food) string {
	names := make([]string, 0, len(items))
	for _, it := range items {
		names = append(names, it.Name)
	}
	if len(names) <= 3 {
		return humanJoin(names)
	}
	return humanJoin(names[:2]) + " +" + strconv.Itoa(len(names)-2) + " more"
}

func humanJoin(n []string) string {
	switch len(n) {
	case 0:
		return ""
	case 1:
		return n[0]
	case 2:
		return n[0] + " & " + n[1]
	default:
		return strings.Join(n[:len(n)-1], ", ") + " & " + n[len(n)-1]
	}
}
```

Add imports to `service.go`: `"crypto/sha1"`, `"encoding/hex"`, `"strconv"`, `"strings"`.

- [ ] **Step 4: Run to verify tests pass**

Run: `cd api && go test -race -p 1 ./internal/memory/`
Expected: PASS (all memory tests).

- [ ] **Step 5: Commit**

```bash
git add api/internal/memory/service.go api/internal/memory/service_test.go
git commit -m "feat(memory): auto-detect usual meals via day/slot food-set clustering"
```

---

### Task 5: `GET /v1/memory` handler + wiring

**Files:**
- Create: `api/internal/memory/handler.go`
- Modify: `api/internal/server/router.go` (construct + register)
- Test: `api/internal/memory/handler_test.go`

**Interfaces:**
- Consumes: `Service.Build`, the user-id + `*time.Location` context helpers already used by `foodlog.Handler` (read `foodlog/handler.go` for the exact helper names — reuse them, do not invent).
- Produces: `func NewHandler(svc Service) Handler`, `func (h Handler) Get(c *gin.Context)` at `GET /v1/memory`.

- [ ] **Step 1: Write the failing handler test** — `handler_test.go`. Use a fake `LogSource` (no DB) so this stays a pure handler test:

```go
package memory

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

type fakeLogs struct{ logs []foodlog.FoodLog }

func (f fakeLogs) ListForUserSince(_ context.Context, _ uuid.UUID, _ time.Time) ([]foodlog.FoodLog, error) {
	return f.logs, nil
}

func TestGetMemoryReturnsSections(t *testing.T) {
	gin.SetMode(gin.TestMode)
	base := time.Now().Add(-24 * time.Hour)
	svc := NewService(fakeLogs{logs: []foodlog.FoodLog{log(eggs, "Eggs", "breakfast", 100, 155, base)}})
	h := NewHandler(svc)

	r := gin.New()
	r.GET("/v1/memory", func(c *gin.Context) {
		c.Set("user_id", uuid.NewString()) // match the key foodlog handlers read
		h.Get(c)
	})
	req, _ := http.NewRequest(http.MethodGet, "/v1/memory", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK { t.Fatalf("want 200 got %d", w.Code) }
	var body Memory
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil { t.Fatal(err) }
	if len(body.Recents) != 1 { t.Fatalf("want 1 recent, got %d", len(body.Recents)) }
}
```

(Read `foodlog/handler.go` for the **exact** context key/helper used to read the user id and location; set the same key in the test and use the same helper in the handler. Adjust the `c.Set(...)` key accordingly.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && go test -race -p 1 ./internal/memory/ -run TestGetMemory`
Expected: FAIL — `NewHandler`/`Get` undefined.

- [ ] **Step 3: Implement `handler.go`** (reuse `foodlog`'s user-id + loc context helpers verbatim):

```go
package memory

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tesserix/kora/api/internal/httpx"
	// import the package that exposes the shared user-id / location context helpers
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) Get(c *gin.Context) {
	userID, ok := userIDFromContext(c) // same helper foodlog.Handler uses
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	loc := locFromContext(c) // same helper foodlog.Handler uses; returns *time.Location (UTC fallback)
	mem, err := h.svc.Build(c.Request.Context(), userID, time.Now(), loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, mem)
}
```

- [ ] **Step 4: Wire the route** — in `router.go`, near the foodlog block (after line 86):

```go
memoryHandler := memory.NewHandler(memory.NewService(logRepo))
v1.GET("/memory", memoryHandler.Get)
```

Add `"github.com/tesserix/kora/api/internal/memory"` to router.go imports. (`logRepo` already exists at line 76 and satisfies `memory.LogSource` via Task 1.)

- [ ] **Step 5: Run memory tests + build the server**

Run: `cd api && go test -race -p 1 ./internal/memory/ && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add api/internal/memory/handler.go api/internal/memory/handler_test.go api/internal/server/router.go
git commit -m "feat(memory): GET /v1/memory endpoint"
```

---

### Task 6: Mobile — memory types + hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (add `MemoryFood`, `MemoryMeal`, `Memory`)
- Modify: `apps/mobile/src/api/hooks.ts` (add `useMemory`, `useCreateLogBatch`)
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx` (add hook tests, mirror existing hook tests)

**Interfaces:**
- Produces:
  - Types matching the Go JSON (`MemoryFood`, `MemoryMeal`, `Memory`).
  - `useMemory(date: string)` → `useQuery(["memory", date], GET /v1/memory?date=)`.
  - `useCreateLogBatch()` → mutation `POST /v1/logs/batch`, invalidates `["logs"]` + `["dashboard"]`.

- [ ] **Step 1: Add types** to `types.ts`:

```ts
export type MemoryFood = {
  food_item_id: string;
  name: string;
  meal_slot: string;
  grams: number;
  kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number;
  count: number;
  last_logged_at: string;
};
export type MemoryMeal = {
  id: string;
  name: string;
  meal_slot: string;
  items: MemoryFood[];
  kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number;
  count: number;
  last_logged_at: string;
};
export type Memory = { recents: MemoryFood[]; frequent: MemoryFood[]; usual_meals: MemoryMeal[] };
```

- [ ] **Step 2: Write failing hook tests** — add to `hooks.test.tsx` (mirror the existing `useFoodSearch`/`useCreateLog` tests in that file — same `QueryClientProvider` wrapper + `apiFetch` mock; `await renderHook`):

```tsx
test("useMemory fetches GET /v1/memory for the date", async () => {
  mockApiFetch.mockResolvedValueOnce({ recents: [], frequent: [], usual_meals: [] });
  const { result } = await renderHook(() => useMemory("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/memory?date=2026-07-27");
});

test("useCreateLogBatch posts to /v1/logs/batch", async () => {
  mockApiFetch.mockResolvedValueOnce([{ id: "1" }]);
  const { result } = await renderHook(() => useCreateLogBatch(), { wrapper });
  await result.current.mutateAsync({ logged_at: "2026-07-27T12:00:00Z", meal_slot: "breakfast", items: [{ food_item_id: "abc", quantity_grams: 60 }] });
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/logs/batch", expect.objectContaining({ method: "POST" }));
});
```

(Copy the exact `wrapper`, `mockApiFetch`, and `waitFor` setup already at the top of `hooks.test.tsx`.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/mobile && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useMemory`/`useCreateLogBatch` not exported.

- [ ] **Step 4: Implement the hooks** in `hooks.ts`:

```ts
export function useMemory(date: string) {
  return useQuery({
    queryKey: ["memory", date],
    queryFn: () => apiFetch(`/v1/memory?date=${date}`) as Promise<Memory>,
  });
}

type BatchLogInput = {
  logged_at: string;
  meal_slot: string;
  items: { food_item_id: string; quantity_grams: number }[];
};

export function useCreateLogBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BatchLogInput) =>
      apiFetch("/v1/logs/batch", { method: "POST", body: JSON.stringify(input) }) as Promise<FoodLog[]>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

Add `Memory` to the `types` import block at the top of `hooks.ts`.

- [ ] **Step 5: Run to verify they pass + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): memory types + useMemory/useCreateLogBatch hooks"
```

---

### Task 7: Mobile — Undo Toast component

**Files:**
- Create: `apps/mobile/src/components/Toast.tsx`
- Create: `apps/mobile/src/components/__tests__/Toast.test.tsx`

**Interfaces:**
- Produces: a `ToastProvider` + `useToast()` returning `show({ message, actionLabel?, onAction?, durationMs? })`. A single bottom toast that auto-dismisses after `durationMs` (default 5000) and renders an optional action button. Mounted once near the app root.

- [ ] **Step 1: Write failing test** — `Toast.test.tsx` (RNTL v14, `await render`; fake timers):

```tsx
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text, Pressable } from "react-native";
import { ToastProvider, useToast } from "../Toast";

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return <Pressable onPress={() => toast.show({ message: "Logged", actionLabel: "Undo", onAction: onUndo })}><Text>go</Text></Pressable>;
}

test("shows a message and fires the action", async () => {
  const onUndo = jest.fn();
  const { getByText } = await render(
    <ToastProvider><Trigger onUndo={onUndo} /></ToastProvider>,
  );
  fireEvent.press(getByText("go"));
  await waitFor(() => getByText("Logged"));
  fireEvent.press(getByText("Undo"));
  expect(onUndo).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/__tests__/Toast.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Toast.tsx`** (context + a single animated bottom toast; tokens-only; Reanimated fade/slide):

```tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { View, Pressable } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void; durationMs?: number };
type ToastApi = { show: (o: ToastOptions) => void };

const Ctx = createContext<ToastApi>({ show: () => {} });
export function useToast() { return useContext(Ctx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors, radius, spacing, shadows } = useTheme();
  const [toast, setToast] = useState<ToastOptions | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback((o: ToastOptions) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(o);
    timer.current = setTimeout(() => setToast(null), o.durationMs ?? 5000);
  }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {toast ? (
        <Animated.View entering={FadeInDown} exiting={FadeOutDown}
          style={{ position: "absolute", left: 20, right: 20, bottom: 96, flexDirection: "row", alignItems: "center",
            justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.lg,
            backgroundColor: colors.elevated, ...shadows.card }}>
          <AppText style={{ flex: 1 }}>{toast.message}</AppText>
          {toast.actionLabel ? (
            <Pressable accessibilityRole="button" accessibilityLabel={toast.actionLabel}
              onPress={() => { toast.onAction?.(); dismiss(); }} style={{ marginLeft: spacing.md }}>
              <AppText style={{ color: colors.accent, fontWeight: "700" }}>{toast.actionLabel}</AppText>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}
```

- [ ] **Step 4: Mount the provider** — wrap the app root. In `apps/mobile/app/_layout.tsx`, wrap the `<Stack>` with `<ToastProvider>` (inside `UnitsProvider`, so it's available to all screens):

```tsx
// import { ToastProvider } from "@/components/Toast";
// ...
<UnitsProvider>
  <ToastProvider>
    <Stack ... />
  </ToastProvider>
</UnitsProvider>
```

- [ ] **Step 5: Run tests + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/__tests__/Toast.test.tsx`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/Toast.tsx apps/mobile/src/components/__tests__/Toast.test.tsx apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): Undo toast provider"
```

---

### Task 8: Mobile — Log-screen memory library

**Files:**
- Modify: `apps/mobile/app/log.tsx` (add the memory library above search)
- Test: `apps/mobile/app/__tests__/log.test.tsx` (add tests)

**Interfaces:**
- Consumes: `useMemory`, `useCreateLog`, `useCreateLogBatch`, `useDeleteLog`, `useToast`, `Segmented`, `GroupedSection`, `Row`.

- [ ] **Step 1: Write failing tests** — add to `log.test.tsx` (mock `@/api/hooks` `useMemory` to return one recent food + one usual meal; mock `useCreateLog`/`useCreateLogBatch`/`useDeleteLog` mutate spies; mock `@/components/Toast` `useToast` to synchronously invoke `onAction` when asserting undo). Mirror the existing log.test setup:

```tsx
test("tapping a recent food logs it instantly", async () => {
  const logMutate = jest.fn();
  // ...wire mocks: useMemory -> { data: { recents:[FOOD], frequent:[], usual_meals:[] } }, useCreateLog -> { mutate: logMutate }
  const { getByText } = await render(<Log />);
  fireEvent.press(getByText("Eggs"));
  expect(logMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "eggs-id", quantity_grams: 100, meal_slot: "breakfast" }),
    expect.anything(),
  );
});

test("tapping a usual meal batch-logs its items", async () => {
  const batchMutate = jest.fn();
  // ...useMemory -> usual_meals:[{ id, name:"Eggs & Oats", meal_slot:"breakfast", items:[eggs,oats], ... }], useCreateLogBatch -> { mutate: batchMutate }
  const { getByText } = await render(<Log />);
  fireEvent.press(getByText(/Eggs & Oats/));
  expect(batchMutate).toHaveBeenCalledWith(
    expect.objectContaining({ meal_slot: "breakfast", items: [
      { food_item_id: "eggs-id", quantity_grams: 100 }, { food_item_id: "oats-id", quantity_grams: 60 },
    ]}),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/mobile && npm test -- --ci app/__tests__/log.test.tsx`
Expected: FAIL — memory rows not rendered / mutate not called.

- [ ] **Step 3: Implement the memory library** in `log.tsx`. Above the existing search `Card`, when the search query is empty, render a `Segmented` (`Recents · Frequent · Usual meals`, default `recents`) and the active tab's list. Food rows reuse `GroupedSection`+`Row`; meal rows use `Row` with the component-name subtitle + a "×N" detail. On tap:

```tsx
const memory = useMemory(today());
const createLog = useCreateLog();
const batchLog = useCreateLogBatch();
const deleteLog = useDeleteLog();
const toast = useToast();
const [memTab, setMemTab] = useState<"recents" | "frequent" | "usual_meals">("recents");

const logFood = (f: MemoryFood) => {
  createLog.mutate(
    { food_item_id: f.food_item_id, meal_slot: f.meal_slot, source: "memory", quantity_grams: f.grams, logged_at: new Date().toISOString() },
    { onSuccess: (created) => toast.show({ message: `Logged ${f.name}`, actionLabel: "Undo", onAction: () => deleteLog.mutate(created.id) }) },
  );
};

const logMeal = (m: MemoryMeal) => {
  batchLog.mutate(
    { logged_at: new Date().toISOString(), meal_slot: m.meal_slot, items: m.items.map((i) => ({ food_item_id: i.food_item_id, quantity_grams: i.grams })) },
    { onSuccess: (created) => toast.show({ message: `Logged ${m.name}`, actionLabel: "Undo", onAction: () => created.forEach((l) => deleteLog.mutate(l.id)) }) },
  );
};
```

Render (only when `q.length < 2`, so search replaces it when typing):

```tsx
{q.length < 2 ? (
  <>
    <Segmented
      options={[{ key: "recents", label: "Recents" }, { key: "frequent", label: "Frequent" }, { key: "usual_meals", label: "Usual meals" }]}
      value={memTab}
      onChange={(k) => setMemTab(k as typeof memTab)}
    />
    {memTab === "usual_meals" ? (
      <GroupedSection elevated>
        {(memory.data?.usual_meals ?? []).map((m) => (
          <Row key={m.id} title={m.name} subtitle={m.items.map((i) => i.name).join(" · ")} detail={`×${m.count}`} onPress={() => logMeal(m)} />
        ))}
      </GroupedSection>
    ) : (
      <GroupedSection elevated>
        {(memory.data?.[memTab] ?? []).map((f) => (
          <Row key={f.food_item_id} title={f.name} subtitle={`${Math.round(f.grams)}g · ${Math.round(f.kcal)} kcal`} onPress={() => logFood(f)} />
        ))}
      </GroupedSection>
    )}
  </>
) : null}
```

(Follow `log.tsx`'s existing imports/patterns; add `useMemory`, `useCreateLogBatch`, `useDeleteLog` to the hooks import and `useToast` from `@/components/Toast`; import `MemoryFood`/`MemoryMeal` types. Keep the existing search + selected-food detail flow untouched.

State handling (spec §5): while `memory.isLoading`, render a single muted "Loading…" line in place of the list; on `memory.isError`, render a muted "Couldn't load your foods." line; when a tab's list is empty (loaded, no data), render a muted "Log a few meals and they'll show up here." line instead of an empty `GroupedSection`. Keep it to plain muted `AppText` lines — no skeleton component in v1.)

- [ ] **Step 4: Run tests + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci app/__tests__/log.test.tsx`
Expected: PASS + tsc clean.

- [ ] **Step 5: Full suite**

Run: `cd apps/mobile && npm test -- --ci`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add "apps/mobile/app/log.tsx" "apps/mobile/app/__tests__/log.test.tsx"
git commit -m "feat(mobile): personal food memory library in Log screen"
```

---

## Device verification (controller, after all tasks)

Native/animated + toast behavior can't be caught by jest. On the sim (Metro 8091, `com.tesserix.kora`): open Log, confirm the `Recents · Frequent · Usual meals` tabs render, tap a recent food → instant log + "Logged — Undo" toast → Undo removes it; tap a usual meal → batch log + Undo removes all. Seed the demo user with a few days of repeated logs first so Frequent/Usual meals populate (use `cmd/seed` or log via the app). Screenshot each state.

## Out of scope (Phase 2, separate plan)
Home contextual "Your usual" strip; manual pins; meal naming/editing; the fibre dashboard tile.
