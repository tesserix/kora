# Manual Pins / Favorites — Design Spec (Food Memory Phase 2e)

**Status:** Approved (2026-07-28)
**Builds on:** Food Memory v1 (PR #7). Pins is the **first user-curated persistent store** — food "memory" today is 100% derived from `food_logs` with no stored favorite/meal entity.

## Goal

Let users **pin** individual foods so they always appear in a "Pinned" section — in the Log memory library and on the Home strip — regardless of logging frequency. Pinning is a one-tap star toggle; tapping a pinned food logs it (reusing the existing instant-log flow).

## Scope decisions (locked)

- **Foods only.** Pin an individual food (a `food_item` + grams + meal_slot). Pinning whole meals (food-sets) is out of scope (deferred).
- **One pin per food.** `UNIQUE(user_id, food_item_id)` — a food is pinned or not; re-pinning updates the stored default portion. (No per-slot pins.)
- **Two surfaces:** a "Pinned" tab (first) in the Log memory library, and a "Pinned" strip on Home above "Your usual". Star affordance on food rows in both toggles pin/unpin.
- **On-server enrichment.** `GET /v1/pins` returns foods enriched with name + macros (computed server-side, item per-100g × grams), identical in shape to `memory.Food`, so mobile renders and logs a pin exactly like a memory food.

## Out of scope (later)

Pinning meals/food-sets, manual reordering of pins, per-meal-slot pins, sync/sharing, a cap UI (a generous cap is enforced server-side but not surfaced).

---

## 1. Backend — data model

New package `api/internal/pins/` (mirrors `foodlog`/`groups`). Migration `api/internal/database/migrations/000016_pins.up.sql` / `.down.sql`:

```sql
-- up
CREATE TABLE pins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
  grams        DOUBLE PRECISION NOT NULL,
  meal_slot    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, food_item_id)
);
CREATE INDEX idx_pins_user ON pins(user_id);
-- down
DROP TABLE pins;
```

GORM model (`pins/model.go`):
```go
type Pin struct {
    ID         uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
    UserID     uuid.UUID `gorm:"type:uuid;not null;index"`
    FoodItemID uuid.UUID `gorm:"type:uuid;not null"`
    Grams      float64   `gorm:"not null"`
    MealSlot   string    `gorm:"not null"`
    CreatedAt  time.Time
}
func (Pin) TableName() string { return "pins" }
```

- **Cap:** a generous server-side cap `maxPins = 100` (reject `POST` past it with a 400) — not surfaced in UI. iOS-notification-style budget concerns don't apply (pins are just data).

## 2. Backend — repository (`pins/repository.go`)

Follows `foodlog`/`groups` conventions: `type Repository struct { db *gorm.DB }`, `ctx`-first, `r.db.WithContext(ctx)`, errors wrapped `fmt.Errorf("pins: op: %w", err)`, **every query scoped by `user_id`**.

```go
func NewRepository(db *gorm.DB) Repository
// Upsert creates or updates (idempotent on the unique key) — re-pinning a food
// updates its stored grams/meal_slot. Uses ON CONFLICT (user_id, food_item_id).
func (r Repository) Upsert(ctx, p Pin) (Pin, error)
// ListForUser returns the user's pins, newest first (created_at DESC).
func (r Repository) ListForUser(ctx, userID uuid.UUID) ([]Pin, error)
// DeleteForUser removes a pin scoped by user_id AND food_item_id (a no-op if absent).
func (r Repository) DeleteForUser(ctx, userID, foodItemID uuid.UUID) error
// CountForUser is used to enforce maxPins.
func (r Repository) CountForUser(ctx, userID uuid.UUID) (int64, error)
```

`Upsert` uses GORM `clause.OnConflict{Columns: user_id+food_item_id, DoUpdates: grams+meal_slot}`.

## 3. Backend — service (`pins/service.go`)

Depends on the pins `Repository` **and** the nutrition food repository (to enrich name/macros). Business logic + validation; returns `httpx.ValidationError` for 400s.

```go
type FoodSource interface { // satisfied by nutrition.Repository
    GetByID(ctx, id uuid.UUID) (nutrition.FoodItem, error)
}
type Service struct { repo Repository; foods FoodSource }
func NewService(repo Repository, foods FoodSource) *Service

// PinnedFood is the enriched, mobile-facing shape — same fields as memory.Food
// minus count/last_logged_at, so mobile renders/logs it identically.
type PinnedFood struct {
    FoodItemID string  `json:"food_item_id"`
    Name       string  `json:"name"`
    MealSlot   string  `json:"meal_slot"`
    Grams      float64 `json:"grams"`
    Kcal       float64 `json:"kcal"`
    ProteinG   float64 `json:"protein_g"`
    CarbsG     float64 `json:"carbs_g"`
    FatG       float64 `json:"fat_g"`
    FiberG     float64 `json:"fiber_g"`
}

func (s *Service) List(ctx, userID) ([]PinnedFood, error)
func (s *Service) Create(ctx, userID, req CreatePinRequest) (PinnedFood, error) // validates grams>0, valid slot, cap
func (s *Service) Delete(ctx, userID, foodItemID uuid.UUID) error
```

- **Enrichment:** macros = `foodItem.<macro>Per100g × grams / 100` — reuse the exact formula the memory/foodlog service already uses (find it and match it; do not re-derive a different rounding). Name comes from the food item.
- **Validation:** `grams > 0`; `meal_slot ∈ {breakfast,lunch,dinner,snack}`; `food_item_id` must exist (GetByID 404 → 400 `invalid_input` "unknown food"); reject when `CountForUser >= maxPins`.
- If a pinned food's `food_item_id` was deleted (FK CASCADE removes the pin), it simply won't appear — no orphan handling needed.

## 4. Backend — handler + routes

`pins/handler.go` mirrors `foodlog/handler.go`: `resolveUser` via `user.IDFromContext`, bind, call service, respond with the **standard envelope** (`httpx.OK(c, data)` → `{data:...}`; `httpx.RespondServiceError` for errors).

Routes registered in `api/internal/server/router.go` inside the `if deps.DB != nil && deps.Verifier != nil {` block:
```go
pinsHandler := pins.NewHandler(pins.NewService(pins.NewRepository(deps.DB), foodRepo))
v1.GET("/pins", pinsHandler.List)
v1.POST("/pins", pinsHandler.Create)          // body: {food_item_id, grams, meal_slot}
v1.DELETE("/pins/:foodItemId", pinsHandler.Delete)
```
(`foodRepo` is the existing nutrition repository already constructed in the router; if not in scope there, construct `nutrition.NewRepository(deps.DB)`.)

## 5. Mobile — API layer

- **Types** (`src/api/types.ts`): `PinnedFood` = `{ food_item_id, name, meal_slot, grams, kcal, protein_g, carbs_g, fat_g, fiber_g }` (same fields `useInstantLog.logFood` consumes).
- **Hooks** (`src/api/hooks.ts`, following `useMemory`/`useCreateLog`):
  - `usePins()` → `useQuery({ queryKey:["pins"], queryFn: () => apiFetch("/v1/pins") })` → `PinnedFood[]`.
  - `useCreatePin()` → `useMutation({ mutationFn: (b:{food_item_id;grams;meal_slot}) => apiFetch("/v1/pins",{method:"POST",body:...}), onSuccess: invalidate ["pins"] })`.
  - `useDeletePin()` → `useMutation({ mutationFn: (foodItemId) => apiFetch(\`/v1/pins/${foodItemId}\`,{method:"DELETE"}), onSuccess: invalidate ["pins"] })`.
- **`usePinToggle()`** (`src/api/usePinToggle.ts`): exposes `pinnedIds: Set<string>` (from `usePins`) and `toggle(food: {food_item_id;grams;meal_slot})` → if `pinnedIds.has(id)` `deletePin(id)` else `createPin({...})`. Optimistic update of the pinned set (react-query `onMutate`) so the star flips instantly, rolled back on error.

## 6. Mobile — UI

- **`MealRow`** (`src/components/MealRow.tsx`): add optional props `pinned?: boolean; onPinToggle?: () => void`. When `onPinToggle` is provided, render a trailing star `Icon` (filled + `colors.accent` when `pinned`, outline + muted otherwise) wrapped in its **own `Pressable`** with `hitSlop`, so tapping the star calls `onPinToggle` and does NOT trigger the row's `onPress` (which logs). No star when `onPinToggle` is absent (default — existing call sites unchanged). Confirm an available star icon name in the app's `Icon` set; if none, add the glyph.
- **Log "Pinned" tab** (`app/log.tsx`): prepend `{ key: "pinned", label: "Pinned" }` to `MEMORY_TAB_OPTIONS`. Render `usePins()` as `MealRow`s with `pinned` + `onPinToggle` (star filled → unpin), `onPress = logFood`. Add `pinned`/`onPinToggle` (from `usePinToggle`) to the food rows in the `recents`/`frequent` tabs too. The `usual_meals` tab (meal rows) gets **no** star (foods-only). Empty Pinned tab shows a short muted hint ("Star a food to pin it here.").
- **`PinnedStrip`** (`src/components/home/PinnedStrip.tsx`): `usePins()` + `useInstantLog()` + `usePinToggle()`; renders `Overline` "Pinned" + `GroupedSection elevated` of `MealRow`s (tap = `logFood`, star filled = unpin, food-visual icons). Returns `null` while loading/error/empty. Mounted in `app/(tabs)/index.tsx` **above** `<YourUsualStrip/>`.

## 7. Testing

- **Backend (Go, `-race -p 1`, `TEST_DATABASE_URL`):**
  - Repository: `Upsert` creates then updates on re-pin (idempotent, row count stays 1, grams/slot updated); `ListForUser` newest-first + scoped; `DeleteForUser` scoped by user+food; **user isolation** (user A cannot list/delete user B's pins); `CountForUser`.
  - Service: enrichment macros match `item per-100g × grams`; validation (`grams<=0`, bad slot, unknown food → 400); cap at `maxPins`.
  - Handler: `GET`/`POST`/`DELETE` happy paths (200 + envelope), 400 on bad input, 401 unauth.
  - Seed `food_items` per the repo's clean-table test convention (see [[kora-food-index-test-state]] — running `cmd/seed` breaks two nutrition tests locally; keep the pins tests self-seeding + isolated).
- **Mobile:** `usePins`/`useCreatePin`/`useDeletePin`; `MealRow` renders the star only with `onPinToggle`, and pressing the star fires `onPinToggle` **without** the row `onPress`; `usePinToggle.toggle` picks create vs delete off `pinnedIds`; Pinned tab renders pins + empty hint; `PinnedStrip` renders rows / null when empty.
- **Full Go `-race` + mobile suite (`tsc --noEmit && npm test -- --ci`) green**, then device-verify.

## 8. Device verification (after all tasks)

Log screen → star a food in Recents/Frequent → it appears in the **Pinned** tab and the Home **Pinned** strip; tap it to log (Undo toast); unpin via the star → it disappears from both. Confirm pins persist across app reload and are user-scoped.

## 9. Global constraints for implementers

- User isolation on every query (`user_id` scope). Macros server-side only (client sends `food_item_id + grams + meal_slot`; never fabricated numbers). Standard API envelope. Handler→service→repository layering; `httpx.ValidationError` for 400s. Immutable updates (Go + TS). Tokens-only mobile styling; reuse `MealRow`/`foodVisual`/`GroupedSection`/`Overline`/`useInstantLog`. Go: `fmt.Errorf("pins: ...: %w")` wrapping; single-line conventional commits, no signature; stage named files only (never `git add -A`). Branch: `pins` (currently off the reminders/custom-reminders stack; retarget to `main` once the stack merges).
