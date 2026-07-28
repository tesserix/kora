# Saved Meals (Usual-Meal Naming & Editing) — Design Spec (Food Memory Phase 2f)

**Status:** Approved (2026-07-28)
**Builds on:** Food Memory v1 + Pins. Usual meals are **derived** (a stable SHA-1 fingerprint of `meal_slot + sorted(food-id set)`, recomputed from `food_logs` on each request — no stored meal entity). "Naming & editing" a derived meal is impossible in place: rename could ride the fingerprint but detaches when the set changes, and editing items yields a different fingerprint that never re-derives. So this feature persists a real **saved meal** entity instead.

## Goal

Let a user turn a detected "usual meal" into a **saved meal**: give it a name, adjust portions, remove items, pick a default slot — persisted, always visible in a "Saved" section (Log tab + Home strip) regardless of frequency, and logged in one tap. Covers both "naming" and "editing" coherently.

## Scope decisions (locked)

- **Save-from-usual + curate.** You save a usual meal, then rename it, **remove** items, and **adjust grams** per item. **No adding new foods and no build-from-scratch** (keeps the food-search picker out of scope). A saved meal's item set is a curated-down subset of the usual it came from.
- **Persisted entity.** Two tables (`saved_meals` + `saved_meal_items`), not an override on the derivation.
- **Two surfaces:** a "Saved" tab (first) in the Log memory library + a "Saved" strip on Home above the Pinned strip. A **bookmark** affordance on usual-meal rows opens the save/edit sheet; saved-meal rows tap-to-log with the bookmark (filled) re-opening the editor.
- **Logging unchanged server-side:** logging a saved meal sends its items to the existing `POST /v1/logs/batch` (macros recomputed there). Saved meals are a curation layer only.
- **Cap:** 50 saved meals/user (server-enforced, not surfaced).

## Out of scope (later)

Adding foods / building from scratch (food-search picker), reordering items in the UI, per-log custom meal names on diary entries, sharing, a cap UI. Rename-only-of-derived-usuals (rejected — superseded by saved meals).

---

## 1. Backend — data model

New package `api/internal/savedmeals/`. Migration `api/internal/database/migrations/000017_saved_meals.up.sql` / `.down.sql`:

```sql
-- up
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
-- down
DROP TABLE IF EXISTS saved_meal_items;
DROP TABLE IF EXISTS saved_meals;
```

GORM models (`savedmeals/model.go`): `SavedMeal{ID, UserID, Name, MealSlot, CreatedAt}` (`TableName()=="saved_meals"`) and `SavedMealItem{ID, SavedMealID, FoodItemID, Grams, Position}` (`TableName()=="saved_meal_items"`).

- **Cap:** `maxSavedMeals = 50` (reject `POST` past it with 400).

## 2. Backend — repository (`savedmeals/repository.go`)

Two-table, transactional, user-scoped (mirrors `groups`):
- `Create(ctx, m SavedMeal, items []SavedMealItem) (SavedMeal, error)` — one txn: insert meal + items (with `position`).
- `ListForUser(ctx, userID) ([]SavedMeal, error)` — meals newest-first; `ItemsForMeals(ctx, mealIDs) (map[uuid.UUID][]SavedMealItem, error)` or a per-meal load — items ordered by `position`. (One batch query for items to avoid N+1.)
- `Replace(ctx, userID, mealID, m SavedMeal, items []SavedMealItem) error` — txn: verify meal belongs to user, update name/slot, delete old items, insert new. Returns `gorm.ErrRecordNotFound` if not owned.
- `DeleteForUser(ctx, userID, mealID) error` — scoped delete (CASCADE removes items); not-found → error.
- `CountForUser(ctx, userID) (int64, error)`.
- All queries `WHERE user_id = ?`; item queries join/scope through the owning meal so a user can never touch another user's items.

## 3. Backend — service (`savedmeals/service.go`)

Depends on the repo + `nutrition.Repository` (enrichment/validation). Returns `httpx.ValidationError` for 400s.

```go
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
func NewService(repo Repository, foods nutrition.Repository) *Service
func (s *Service) List(ctx, userID) ([]SavedMealView, error)
func (s *Service) Create(ctx, userID, req SaveMealRequest) (SavedMealView, error)
func (s *Service) Update(ctx, userID, mealID uuid.UUID, req SaveMealRequest) (SavedMealView, error)
func (s *Service) Delete(ctx, userID, mealID uuid.UUID) error
```

- **Enrichment:** each item macro = `foodItem.<macro>Per100g × grams / 100.0` (raw float64, no server rounding — matches foodlog/pins); meal totals = sum of item macros; item `Name` from the food item.
- **Validation:** `name` trimmed non-empty (≤80 chars); `meal_slot ∈ {breakfast,lunch,dinner,snack}`; `len(items) >= 1`; each `food_item_id` a valid uuid that exists (GetByID NotFound → ValidationError "unknown food"); `grams > 0` per item; on Create, reject when `CountForUser >= maxSavedMeals`.
- `Update` requires the meal to belong to the user (else NotFound → 404).

## 4. Backend — handler + routes

`savedmeals/handler.go` mirrors `pins`/`foodlog`: `resolveUser` (401), bind, service, standard envelope. Routes in `router.go` inside the DB guard (reuse `foodRepo`):
```go
smHandler := savedmeals.NewHandler(savedmeals.NewService(savedmeals.NewRepository(deps.DB), foodRepo))
v1.GET("/saved-meals", smHandler.List)
v1.POST("/saved-meals", smHandler.Create)         // 201 {data: SavedMealView}
v1.PUT("/saved-meals/:id", smHandler.Update)      // 200 {data: SavedMealView}; 404 if not owned
v1.DELETE("/saved-meals/:id", smHandler.Delete)   // 200 {data:{deleted:true}}
```

## 5. Mobile — API layer

- **Types** (`src/api/types.ts`): `SavedMealItem = { food_item_id, name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g }`; `SavedMeal = { id, name, meal_slot, items: SavedMealItem[], kcal, protein_g, carbs_g, fat_g, fiber_g }`; `LoggableMeal = { name: string; meal_slot: string; items: { food_item_id: string; grams: number }[] }`.
- **Hooks** (`src/api/hooks.ts`): `useSavedMeals()` (query `["savedMeals"]` → `SavedMeal[]`); `useCreateSavedMeal()` (POST `/v1/saved-meals`); `useUpdateSavedMeal()` (PUT `/v1/saved-meals/${id}`); `useDeleteSavedMeal()` (DELETE `/v1/saved-meals/${id}`) — all invalidate `["savedMeals"]`.
- **`useInstantLog.logMeal`** param retyped `MemoryMeal`→`LoggableMeal` (body unchanged — it reads `meal_slot`, `items[].{food_item_id,grams}`, `name`). Existing callers pass `MemoryMeal` (satisfies `LoggableMeal`); `SavedMeal` also satisfies it.

## 6. Mobile — editor + provider + affordance

- **`SavedMealSheet`** (`src/components/meals/SavedMealSheet.tsx`, shared `Sheet`): fields — name `TextInput`; meal-slot `Segmented` (breakfast/lunch/dinner/snack); a scrollable list of items, each row = food name + a grams `TextInput` (decimal-pad) + a remove (–) `Pressable`; **Save** `Button`; **Delete** (edit mode only). Seeded from a `MemoryMeal` (create: prefill name=meal.name, slot=meal.meal_slot, items=meal.items → {food_item_id,name,grams}) or a `SavedMeal` (edit). Validates name non-empty + ≥1 item (inline error). Save → `useCreateSavedMeal`/`useUpdateSavedMeal` with `{name, meal_slot, items:[{food_item_id,grams}]}`; Delete → `useDeleteSavedMeal`.
- **`SavedMealSheetProvider`** (mounted at root alongside the Toast provider) rendering one `<SavedMealSheet>`, exposing `useSavedMealEditor(): { openCreate(m: MemoryMeal): void; openEdit(m: SavedMeal): void }` — so the sheet is reachable from both Log and Home without duplicate instances.
- **`Icon`**: add `bookmark`/`bookmark-fill` glyphs (SF `bookmark`/`bookmark.fill`; Lucide `Bookmark`) to both maps, following the existing `Star`/`Heart` pattern.
- **`MealRow`**: add optional `bookmarked?: boolean; onBookmark?: () => void` → a trailing bookmark `Icon` in its OWN `Pressable` (hitSlop; `bookmark-fill`+`colors.accent` when bookmarked, else `bookmark`+`colors.tertiaryLabel`), rendered only when `onBookmark` provided, and only for meal rows. The star (`onPinToggle`) and bookmark (`onBookmark`) are independent optional trailing controls; a given row uses at most one. The bookmark `Pressable` consumes its tap so the row's `onPress` (log) does not fire.

## 7. Mobile — surfaces

- **Log "Saved" tab** (`app/log.tsx`): prepend `{ key: "saved", label: "Saved" }` to `MEMORY_TAB_OPTIONS` (first, before "Pinned"); widen `memTab`. Add `const savedMeals = useSavedMeals();` and `const { openCreate, openEdit } = useSavedMealEditor();`. The `saved` branch renders `savedMeals.data` as `MealRow`s (name, slot = items names joined, kcal, `onPress={() => logMeal(m)}`, `bookmarked`, `onBookmark={() => openEdit(m)}`); empty → "Save a usual meal to see it here." Add `onBookmark={() => openCreate(m)}` to the `usual_meals` rows.
- **`SavedMealsStrip`** (`src/components/home/SavedMealsStrip.tsx`): `useSavedMeals()` + `useInstantLog()` + `useSavedMealEditor()`; `Overline` "Saved" + `GroupedSection elevated` of `MealRow`s (tap=logMeal, `bookmarked`, onBookmark=openEdit); `null` when loading/error/empty; mounted in `app/(tabs)/index.tsx` ABOVE `<PinnedStrip />`.

## 8. Testing

- **Backend (Go `-race -p 1`, `TEST_DATABASE_URL`, self-seeding food_items/users + cleanup):**
  - Repo: create persists meal + ordered items; ListForUser scoped + items ordered by position; **Replace** updates name/slot and swaps items in a txn (old items gone, new present); DeleteForUser cascades items + scoped; user isolation (A can't list/update/delete B's); CountForUser.
  - Service: enrichment (item macros = per-100g × grams; meal totals summed); validation (empty name, no items, bad slot, unknown food, grams<=0); cap at 50; Update-not-owned → NotFound.
  - Handler: create(201)/list/update(200)/delete round-trip + 400 + 401.
- **Mobile:** hooks; `SavedMealSheet` (create-seed prefills from a MemoryMeal; remove item; edit grams; Save calls create/update with correct payload; Delete calls delete); `MealRow` bookmark is a separate touchable that fires `onBookmark` NOT `onPress`; `useSavedMealEditor` open flows; Log "Saved" tab renders + empty state; `SavedMealsStrip` renders/null.
- **Full Go `-race` + mobile (`tsc --noEmit && npm test -- --ci`) green**, then device-verify.

## 9. Device verification (after all tasks)

Restart API + Metro. Log → usual_meals tab → tap a usual meal's **bookmark** → the editor sheet opens seeded with its name/items → rename, remove an item, adjust a portion → Save → it appears in the **Saved** tab and the Home **Saved** strip → tap it to log (Undo toast) → tap its bookmark → editor re-opens → Delete removes it. Confirm the bookmark tap never logs, and saved meals persist across reload and are user-scoped.

## 10. Global constraints for implementers

- User isolation on every query (meals + items scoped through the owning user). Macros server-side only (client sends `food_item_id + grams`; never fabricated). Standard envelope. Handler→service→repository layering; two-table writes in a transaction; `httpx.ValidationError` for 400s; `fmt.Errorf("savedmeals: <op>: %w", err)`. Immutable updates (Go + TS). Tokens-only mobile styling; reuse `MealRow`/`foodVisual`/`hslToHex`/`GroupedSection`/`Overline`/`Sheet`/`Button`/`Segmented`/`useInstantLog`. Single-line conventional commits, no signature; stage named files only (never `git add -A`). Branch `usual-meals` off `main`.
