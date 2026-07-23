# Kora Phase 1a — Core Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can onboard (goal → macro targets), search a seeded food database, log meals manually (with backdating, copy-previous-day, and repeat-meal), add water, and see a daily dashboard of intake vs. targets with a streak.

**Architecture:** Extends the Phase 0 Go monolith with three domain packages (`nutrition`, `foodlog`, `tracking`) following the committed `internal/user` handler→repository pattern exactly, plus onboarding on `user`. Food search is `ILIKE` over a dev-seeded `food_items` table (full-text + embeddings deferred to Phase 1b). The Expo app gains a config guard, onboarding flow, food-log flow, and dashboard, all built on the Phase 0 theme + primitives.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, testify · Expo SDK 57, Expo Router, TS strict, React Query (added this phase for server state) · Postgres 15.

## Global Constraints

- Go 1.26; Gin; GORM + `gorm.io/driver/postgres`; golang-migrate. Reuse the Phase 0 `internal/user` package as the canonical handler→repository→model pattern.
- JSON success envelope `{"data": ...}` via `httpx.OK`; error envelope `{"error":"<code>","message":"<message>"}` via `httpx.Error`. No other shapes.
- Every user-scoped table has a `user_id UUID NOT NULL` column and every query filters by the authenticated user's `users.id`. The auth middleware provides Firebase UID via `c.GetString("uid")`; resolve it to `users.id` (never trust a client-supplied user id).
- Money/precision: store nutrition per-100g as `double precision`; compute logged macros server-side, never trust client-sent totals.
- Units are metric (AU-first): grams, millilitres, kilograms, centimetres.
- Single-line conventional commits (`feat:`/`fix:`/`test:`/`chore:`), no signatures, no multi-line body.
- Immutability: functions return new values; no mutation of inputs.
- Go: no `panic` outside `main.go`; errors wrapped `fmt.Errorf("context: %w", err)`; handler→service?→repository layering.
- Mobile: TS `strict: true`, no `any` (parse `unknown` and narrow); named prop types; theme tokens only (no hardcoded colors/radii/spacing); `@testing-library/react-native` v14 `render()` is **async** — always `await render(...)`.
- Firebase/AI keys server-side only; mobile Firebase config from `EXPO_PUBLIC_FIREBASE_*` env.

## Context for the implementer

Phase 0 (merged to `main`) provides:
- `api/internal/config`, `internal/httpx` (`OK`, `Error`), `internal/database` (`Connect`, `Migrate`, embedded `migrations/`), `internal/auth` (`Middleware`, `TokenVerifier`, `Claims{UID,Email}`), `internal/user` (`User` model, `Repository.UpsertByFirebaseUID`, `Handler.Me`), `internal/server` (`NewRouter(Deps{DB, Verifier})`).
- `apps/mobile`: Expo Router app; `src/theme` (`useTheme()` → `{colors, spacing, radius, fontSize, scheme}`); `src/components` (`AppText` variant h1/h2/h3/body/caption + `muted`; `Button` title/variant primary|secondary|ghost/disabled; `Card`); `src/lib/firebase.ts` (`auth`), `src/lib/api.ts` (`apiFetch(path, init?)`, `ApiError{status,code,message}`).
- Migrations live at `api/internal/database/migrations/` (package-relative `go:embed`). The next migration is `000002`.

Read `api/internal/user/{model,repository,handler}.go` before starting — it is the pattern every backend domain task copies.

**Shared helper added in Task 2, used by every protected handler:** `httpx`/`auth` do not resolve Firebase UID → users.id. Task 2 adds `user.Repository.IDByFirebaseUID(ctx, firebaseUID) (uuid.UUID, error)`; later handlers call it to scope queries.

---

### Task 1: Firebase config guard (mobile)

Currently `src/lib/firebase.ts` calls `initializeAuth` unconditionally; with blank `EXPO_PUBLIC_FIREBASE_API_KEY` the SDK throws `auth/invalid-api-key` at import time and the whole app red-boxes (verified on device). Make missing config a graceful state.

**Files:**
- Modify: `apps/mobile/src/lib/firebase.ts`
- Create: `apps/mobile/src/lib/firebaseConfig.ts`, `apps/mobile/src/lib/__tests__/firebaseConfig.test.ts`
- Modify: `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/app/config-missing.tsx`

**Interfaces:**
- Produces:
  - `firebaseConfig.ts`: `type FirebaseConfig = {apiKey:string; authDomain:string; projectId:string; appId:string}`; `readFirebaseConfig(): FirebaseConfig | null` — returns null if any of apiKey/appId is empty/undefined.
  - `firebase.ts`: `auth` is now `Auth | null` (null when config missing); `isFirebaseConfigured: boolean`.
  - `/config-missing` route: a themed screen explaining Firebase isn't configured.

- [ ] **Step 1: Write failing config-reader test** — `apps/mobile/src/lib/__tests__/firebaseConfig.test.ts`

```ts
import { readFirebaseConfig } from "../firebaseConfig";

const KEYS = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

test("returns null when apiKey is missing", () => {
  process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN = "x.firebaseapp.com";
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = "x";
  process.env.EXPO_PUBLIC_FIREBASE_APP_ID = "1:2:web:3";
  expect(readFirebaseConfig()).toBeNull();
});

test("returns config when all required fields present", () => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = "AIzaKEY";
  process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN = "x.firebaseapp.com";
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = "x";
  process.env.EXPO_PUBLIC_FIREBASE_APP_ID = "1:2:web:3";
  expect(readFirebaseConfig()).toEqual({
    apiKey: "AIzaKEY",
    authDomain: "x.firebaseapp.com",
    projectId: "x",
    appId: "1:2:web:3",
  });
});
```

Note: Expo inlines `process.env.EXPO_PUBLIC_*` at build time, but in Jest they are ordinary runtime env reads, so the test can set them. `readFirebaseConfig` must read each var through a direct `process.env.EXPO_PUBLIC_FIREBASE_*` access (not a destructure captured at module load) so the test's `process.env` mutations are visible.

- [ ] **Step 2: Run — verify fail**

Run: `cd apps/mobile && npm test -- firebaseConfig`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `apps/mobile/src/lib/firebaseConfig.ts`**

```ts
export type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

export function readFirebaseConfig(): FirebaseConfig | null {
  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  const appId = process.env.EXPO_PUBLIC_FIREBASE_APP_ID;

  if (!apiKey || !appId || !authDomain || !projectId) {
    return null;
  }
  return { apiKey, authDomain, projectId, appId };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd apps/mobile && npm test -- firebaseConfig`
Expected: PASS.

- [ ] **Step 5: Rewrite `apps/mobile/src/lib/firebase.ts` to guard init**

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { initializeApp } from "firebase/app";
import type { Auth } from "firebase/auth";
// Metro resolves `firebase/auth` to the React Native build (dist/rn) at runtime,
// which exports getReactNativePersistence; the default published types omit it
// (firebase#8674).
// @ts-expect-error - getReactNativePersistence exists in the RN build only
import { getReactNativePersistence, initializeAuth } from "firebase/auth";
import { readFirebaseConfig } from "./firebaseConfig";

const config = readFirebaseConfig();

export const isFirebaseConfigured = config !== null;

export const auth: Auth | null = config
  ? initializeAuth(initializeApp(config), {
      persistence: getReactNativePersistence(AsyncStorage),
    })
  : null;
```

- [ ] **Step 6: Add `/config-missing` screen** — `apps/mobile/app/config-missing.tsx`

```tsx
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export default function ConfigMissing() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Almost there</AppText>
      <Card>
        <AppText variant="h3">Firebase isn&apos;t configured</AppText>
        <AppText muted>
          Set EXPO_PUBLIC_FIREBASE_API_KEY, AUTH_DOMAIN, PROJECT_ID, and APP_ID in
          apps/mobile/.env, then reload the app.
        </AppText>
      </Card>
    </View>
  );
}
```

- [ ] **Step 7: Route unconfigured app to the guard screen** — modify `apps/mobile/app/_layout.tsx`

```tsx
import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) {
      router.replace("/config-missing");
    }
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}
```

Also guard the consumers so they don't call a null `auth`: in `app/index.tsx` and `app/sign-in.tsx`, early-return `null` when `!isFirebaseConfigured` (the layout redirect handles navigation). Add at the top of each component body:

```tsx
if (!isFirebaseConfigured) return null;
```

(import `isFirebaseConfigured` from `@/lib/firebase`). Where those files call `auth` methods, assert non-null via a local `const a = auth!;` immediately after the guard, or narrow with `if (!auth) return;` inside async handlers.

- [ ] **Step 8: Update the existing api mock** — `apps/mobile/src/lib/__tests__/api.test.ts` mocks `../firebase` with `{ auth: { currentUser: ... } }`. That still satisfies the new `Auth | null` type at runtime (mock). Confirm it still passes; if TS complains in the mock, it won't (jest.mock factory is untyped). Run the whole suite.

Run: `cd apps/mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/lib apps/mobile/app
git commit -m "fix: guard firebase init and route to config-missing when unconfigured"
```

---

### Task 2: Phase 1 data-model migration + user onboarding columns

**Files:**
- Create: `api/internal/database/migrations/000002_phase1_core.up.sql`, `api/internal/database/migrations/000002_phase1_core.down.sql`
- Modify: `api/internal/user/model.go`, `api/internal/user/repository.go`
- Create: `api/internal/user/repository_id_test.go`

**Interfaces:**
- Produces:
  - Tables: `food_items`, `food_aliases`, `food_logs`, `water_entries`, `weight_entries` (schemas below).
  - `user.User` gains onboarding columns: `Sex string`, `BirthYear int`, `HeightCm float64`, `WeightKg float64`, `ActivityLevel string`, `Goal string`, `TargetKcal float64`, `TargetProteinG float64`, `TargetCarbsG float64`, `TargetFatG float64`, `OnboardedAt *time.Time`.
  - `user.Repository.IDByFirebaseUID(ctx, firebaseUID string) (uuid.UUID, error)` — resolves the authenticated Firebase UID to the internal `users.id` (returns wrapped error if not found).

- [ ] **Step 1: Write the up migration** — `api/internal/database/migrations/000002_phase1_core.up.sql`

```sql
-- User onboarding columns
ALTER TABLE users
    ADD COLUMN sex TEXT NOT NULL DEFAULT '',
    ADD COLUMN birth_year INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN height_cm DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN activity_level TEXT NOT NULL DEFAULT '',
    ADD COLUMN goal TEXT NOT NULL DEFAULT '',
    ADD COLUMN target_kcal DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_protein_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_carbs_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_fat_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN onboarded_at TIMESTAMPTZ;

CREATE TABLE food_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    provenance TEXT NOT NULL,               -- afcd | off | usda | label_ocr | user_estimate
    barcode TEXT,
    serving_desc TEXT NOT NULL DEFAULT '',
    serving_grams DOUBLE PRECISION NOT NULL DEFAULT 0,
    kcal_per_100g DOUBLE PRECISION NOT NULL,
    protein_per_100g DOUBLE PRECISION NOT NULL,
    carbs_per_100g DOUBLE PRECISION NOT NULL,
    fat_per_100g DOUBLE PRECISION NOT NULL,
    fiber_per_100g DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_items_name ON food_items USING gin (to_tsvector('simple', name));
CREATE INDEX idx_food_items_name_trgm ON food_items (lower(name));
CREATE UNIQUE INDEX idx_food_items_barcode ON food_items (barcode) WHERE barcode IS NOT NULL;

CREATE TABLE food_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias TEXT NOT NULL,
    food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_aliases_alias ON food_aliases (lower(alias));

CREATE TABLE food_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_item_id UUID REFERENCES food_items(id) ON DELETE SET NULL,
    logged_at TIMESTAMPTZ NOT NULL,
    meal_slot TEXT NOT NULL,                -- breakfast | lunch | dinner | snack
    source TEXT NOT NULL,                   -- manual | barcode | photo | chat | voice
    description TEXT NOT NULL DEFAULT '',
    quantity_grams DOUBLE PRECISION NOT NULL,
    kcal DOUBLE PRECISION NOT NULL,
    protein_g DOUBLE PRECISION NOT NULL,
    carbs_g DOUBLE PRECISION NOT NULL,
    fat_g DOUBLE PRECISION NOT NULL,
    fiber_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL,               -- copied from food_item or 'user_estimate'
    client_log_ms INTEGER,                  -- client-measured time-to-log (success metric)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_logs_user_logged ON food_logs (user_id, logged_at);

CREATE TABLE water_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_at TIMESTAMPTZ NOT NULL,
    volume_ml INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_water_entries_user_logged ON water_entries (user_id, logged_at);

CREATE TABLE weight_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_at TIMESTAMPTZ NOT NULL,
    weight_kg DOUBLE PRECISION NOT NULL,
    body_fat_pct DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_weight_entries_user_logged ON weight_entries (user_id, logged_at);
```

- [ ] **Step 2: Write the down migration** — `api/internal/database/migrations/000002_phase1_core.down.sql`

```sql
DROP TABLE weight_entries;
DROP TABLE water_entries;
DROP TABLE food_logs;
DROP TABLE food_aliases;
DROP TABLE food_items;

ALTER TABLE users
    DROP COLUMN sex,
    DROP COLUMN birth_year,
    DROP COLUMN height_cm,
    DROP COLUMN weight_kg,
    DROP COLUMN activity_level,
    DROP COLUMN goal,
    DROP COLUMN target_kcal,
    DROP COLUMN target_protein_g,
    DROP COLUMN target_carbs_g,
    DROP COLUMN target_fat_g,
    DROP COLUMN onboarded_at;
```

- [ ] **Step 3: Extend `user.User`** — add columns to `api/internal/user/model.go`

```go
type User struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	FirebaseUID string    `gorm:"uniqueIndex" json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`

	Sex           string     `json:"sex"`
	BirthYear     int        `json:"birth_year"`
	HeightCm      float64    `json:"height_cm"`
	WeightKg      float64    `json:"weight_kg"`
	ActivityLevel string     `json:"activity_level"`
	Goal          string     `json:"goal"`
	TargetKcal    float64    `json:"target_kcal"`
	TargetProteinG float64   `json:"target_protein_g"`
	TargetCarbsG   float64   `json:"target_carbs_g"`
	TargetFatG     float64   `json:"target_fat_g"`
	OnboardedAt   *time.Time `json:"onboarded_at"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
```

- [ ] **Step 4: Write failing test for `IDByFirebaseUID`** — `api/internal/user/repository_id_test.go`

```go
package user

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func idTestDB(t *testing.T) *gorm.DB {
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

func TestIDByFirebaseUID(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "id-test-uid") })

	created, err := repo.UpsertByFirebaseUID(context.Background(), "id-test-uid", "id@test.dev")
	require.NoError(t, err)

	got, err := repo.IDByFirebaseUID(context.Background(), "id-test-uid")
	require.NoError(t, err)
	require.Equal(t, created.ID, got)
}

func TestIDByFirebaseUIDNotFound(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	_, err := repo.IDByFirebaseUID(context.Background(), "does-not-exist-uid")
	require.Error(t, err)
}
```

- [ ] **Step 5: Run — verify fail**

Run (docker-compose up first): `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/migrate && go test ./internal/user/ -run TestIDByFirebaseUID -v`
Expected: FAIL (`IDByFirebaseUID` undefined).

- [ ] **Step 6: Implement** — append to `api/internal/user/repository.go`

```go
func (r Repository) IDByFirebaseUID(ctx context.Context, firebaseUID string) (uuid.UUID, error) {
	var u User
	if err := r.db.WithContext(ctx).
		Select("id").
		Where("firebase_uid = ?", firebaseUID).
		First(&u).Error; err != nil {
		return uuid.Nil, fmt.Errorf("user: id by firebase uid: %w", err)
	}
	return u.ID, nil
}
```

Add `"github.com/google/uuid"` to the import block.

- [ ] **Step 7: Run — verify pass, then full suite**

Run: `cd api && go test ./... `
Expected: PASS (migration applied, both id tests green).

- [ ] **Step 8: Commit**

```bash
git add api/internal/database/migrations api/internal/user
git commit -m "feat: phase 1 schema and user onboarding columns"
```

---

### Task 3: `nutrition` package — FoodItem model, repository, seed loader + dev seed

**Files:**
- Create: `api/internal/nutrition/model.go`, `api/internal/nutrition/repository.go`, `api/internal/nutrition/seed.go`, `api/internal/nutrition/seed_data.go`, `api/internal/nutrition/repository_test.go`
- Create: `api/cmd/seed/main.go`

**Interfaces:**
- Consumes: `Deps.DB`.
- Produces:
  - `nutrition.FoodItem` GORM model (table `food_items`) with the columns from Task 2, JSON-tagged.
  - `nutrition.Provenance` string constants: `ProvenanceAFCD="afcd"`, `ProvenanceOFF="off"`, `ProvenanceUSDA="usda"`, `ProvenanceLabelOCR="label_ocr"`, `ProvenanceUserEstimate="user_estimate"`.
  - `nutrition.Repository` with `Search(ctx, query string, limit int) ([]FoodItem, error)` (ILIKE on name+alias, capped), `GetByID(ctx, id uuid.UUID) (FoodItem, error)`, `Count(ctx) (int64, error)`, `Insert(ctx, items []FoodItem) error` (skip if barcode/name+brand already present).
  - `nutrition.SeedItems() []FoodItem` — the ~60 curated AU foods.
  - `nutrition.Seed(ctx, repo Repository) (inserted int, err error)` — idempotent loader used by `cmd/seed` and tests.
  - `cmd/seed`: standalone binary that connects via `DATABASE_URL`, runs `Seed`, logs count.
  - **Ingestion skeleton:** `nutrition.Ingester` interface `{ Name() string; Fetch(ctx) ([]FoodItem, error) }` with a doc comment noting external-source implementations (AFCD/OFF/USDA) land in Phase 1b; `SeedIngester` is the one implementation, wrapping `SeedItems()`.

- [ ] **Step 1: Write the model** — `api/internal/nutrition/model.go`

```go
// Package nutrition owns canonical food records and their lookup.
package nutrition

import (
	"time"

	"github.com/google/uuid"
)

type Provenance = string

const (
	ProvenanceAFCD         Provenance = "afcd"
	ProvenanceOFF          Provenance = "off"
	ProvenanceUSDA         Provenance = "usda"
	ProvenanceLabelOCR     Provenance = "label_ocr"
	ProvenanceUserEstimate Provenance = "user_estimate"
)

type FoodItem struct {
	ID             uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name           string    `json:"name"`
	Brand          string    `json:"brand"`
	Provenance     string    `json:"provenance"`
	Barcode        *string   `json:"barcode,omitempty"`
	ServingDesc    string    `json:"serving_desc"`
	ServingGrams   float64   `json:"serving_grams"`
	KcalPer100g    float64   `json:"kcal_per_100g"`
	ProteinPer100g float64   `json:"protein_per_100g"`
	CarbsPer100g   float64   `json:"carbs_per_100g"`
	FatPer100g     float64   `json:"fat_per_100g"`
	FiberPer100g   float64   `json:"fiber_per_100g"`
	CreatedAt      time.Time `json:"created_at"`
}
```

- [ ] **Step 2: Write the seed data** — `api/internal/nutrition/seed_data.go`

Provide `SeedItems()` returning a slice of ~60 common AU foods. Use realistic per-100g values from public nutrition data. Include at least: whole foods (chicken breast grilled, salmon, white/brown rice cooked, broccoli, banana, apple, egg, rolled oats, greek yoghurt full/low fat, avocado, sweet potato, potato, beef mince, tuna canned, almonds, peanut butter, bread wholemeal, milk full/skim, cheddar), AU staples (flat white with full-cream milk, Weet-Bix, Vegemite on toast, meat pie, sausage roll), and a few branded barcode items. Full literal slice:

```go
package nutrition

func ptr(s string) *string { return &s }

// SeedItems returns a curated dev set of common Australian foods.
// Per-100g macros are approximate public values; provenance is tagged accordingly.
func SeedItems() []FoodItem {
	return []FoodItem{
		{Name: "Grilled chicken breast", Provenance: ProvenanceAFCD, ServingDesc: "1 breast (170g)", ServingGrams: 170, KcalPer100g: 165, ProteinPer100g: 31, CarbsPer100g: 0, FatPer100g: 3.6, FiberPer100g: 0},
		{Name: "Salmon fillet, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 fillet (150g)", ServingGrams: 150, KcalPer100g: 208, ProteinPer100g: 20, CarbsPer100g: 0, FatPer100g: 13, FiberPer100g: 0},
		{Name: "White rice, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (158g)", ServingGrams: 158, KcalPer100g: 130, ProteinPer100g: 2.7, CarbsPer100g: 28, FatPer100g: 0.3, FiberPer100g: 0.4},
		{Name: "Brown rice, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (195g)", ServingGrams: 195, KcalPer100g: 123, ProteinPer100g: 2.7, CarbsPer100g: 26, FatPer100g: 1, FiberPer100g: 1.8},
		{Name: "Broccoli, steamed", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (91g)", ServingGrams: 91, KcalPer100g: 35, ProteinPer100g: 2.4, CarbsPer100g: 7, FatPer100g: 0.4, FiberPer100g: 3.3},
		{Name: "Banana", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (118g)", ServingGrams: 118, KcalPer100g: 89, ProteinPer100g: 1.1, CarbsPer100g: 23, FatPer100g: 0.3, FiberPer100g: 2.6},
		{Name: "Apple", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (182g)", ServingGrams: 182, KcalPer100g: 52, ProteinPer100g: 0.3, CarbsPer100g: 14, FatPer100g: 0.2, FiberPer100g: 2.4},
		{Name: "Egg, whole", Provenance: ProvenanceAFCD, ServingDesc: "1 large (50g)", ServingGrams: 50, KcalPer100g: 143, ProteinPer100g: 13, CarbsPer100g: 1.1, FatPer100g: 9.5, FiberPer100g: 0},
		{Name: "Rolled oats, dry", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (40g)", ServingGrams: 40, KcalPer100g: 389, ProteinPer100g: 16.9, CarbsPer100g: 66, FatPer100g: 6.9, FiberPer100g: 10.6},
		{Name: "Greek yoghurt, full fat", Provenance: ProvenanceAFCD, ServingDesc: "170g tub", ServingGrams: 170, KcalPer100g: 97, ProteinPer100g: 9, CarbsPer100g: 4, FatPer100g: 5, FiberPer100g: 0},
		{Name: "Greek yoghurt, low fat", Provenance: ProvenanceAFCD, ServingDesc: "170g tub", ServingGrams: 170, KcalPer100g: 59, ProteinPer100g: 10, CarbsPer100g: 3.6, FatPer100g: 0.4, FiberPer100g: 0},
		{Name: "Avocado", Provenance: ProvenanceAFCD, ServingDesc: "1/2 (100g)", ServingGrams: 100, KcalPer100g: 160, ProteinPer100g: 2, CarbsPer100g: 9, FatPer100g: 15, FiberPer100g: 7},
		{Name: "Sweet potato, baked", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (114g)", ServingGrams: 114, KcalPer100g: 90, ProteinPer100g: 2, CarbsPer100g: 21, FatPer100g: 0.2, FiberPer100g: 3.3},
		{Name: "Potato, boiled", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (167g)", ServingGrams: 167, KcalPer100g: 87, ProteinPer100g: 1.9, CarbsPer100g: 20, FatPer100g: 0.1, FiberPer100g: 1.8},
		{Name: "Beef mince, cooked", Provenance: ProvenanceAFCD, ServingDesc: "100g", ServingGrams: 100, KcalPer100g: 250, ProteinPer100g: 26, CarbsPer100g: 0, FatPer100g: 15, FiberPer100g: 0},
		{Name: "Tuna, canned in springwater", Provenance: ProvenanceAFCD, ServingDesc: "95g can", ServingGrams: 95, KcalPer100g: 116, ProteinPer100g: 26, CarbsPer100g: 0, FatPer100g: 1, FiberPer100g: 0},
		{Name: "Almonds", Provenance: ProvenanceAFCD, ServingDesc: "30g handful", ServingGrams: 30, KcalPer100g: 579, ProteinPer100g: 21, CarbsPer100g: 22, FatPer100g: 50, FiberPer100g: 12.5},
		{Name: "Peanut butter", Provenance: ProvenanceAFCD, ServingDesc: "1 tbsp (16g)", ServingGrams: 16, KcalPer100g: 588, ProteinPer100g: 25, CarbsPer100g: 20, FatPer100g: 50, FiberPer100g: 6},
		{Name: "Wholemeal bread", Provenance: ProvenanceAFCD, ServingDesc: "1 slice (40g)", ServingGrams: 40, KcalPer100g: 247, ProteinPer100g: 13, CarbsPer100g: 41, FatPer100g: 3.4, FiberPer100g: 7},
		{Name: "Milk, full cream", Provenance: ProvenanceAFCD, ServingDesc: "250ml", ServingGrams: 258, KcalPer100g: 61, ProteinPer100g: 3.2, CarbsPer100g: 4.8, FatPer100g: 3.3, FiberPer100g: 0},
		{Name: "Milk, skim", Provenance: ProvenanceAFCD, ServingDesc: "250ml", ServingGrams: 258, KcalPer100g: 34, ProteinPer100g: 3.4, CarbsPer100g: 5, FatPer100g: 0.1, FiberPer100g: 0},
		{Name: "Cheddar cheese", Provenance: ProvenanceAFCD, ServingDesc: "1 slice (20g)", ServingGrams: 20, KcalPer100g: 403, ProteinPer100g: 25, CarbsPer100g: 1.3, FatPer100g: 33, FiberPer100g: 0},
		{Name: "Flat white, full cream milk", Provenance: ProvenanceUserEstimate, ServingDesc: "regular (240ml)", ServingGrams: 240, KcalPer100g: 46, ProteinPer100g: 2.5, CarbsPer100g: 3.6, FatPer100g: 2.5, FiberPer100g: 0},
		{Name: "Weet-Bix", Brand: "Sanitarium", Provenance: ProvenanceOFF, Barcode: ptr("9300601011728"), ServingDesc: "2 biscuits (30g)", ServingGrams: 30, KcalPer100g: 349, ProteinPer100g: 12, CarbsPer100g: 67, FatPer100g: 1.3, FiberPer100g: 11},
		{Name: "Vegemite", Brand: "Bega", Provenance: ProvenanceOFF, Barcode: ptr("9300650487987"), ServingDesc: "1 tsp (5g)", ServingGrams: 5, KcalPer100g: 189, ProteinPer100g: 25, CarbsPer100g: 20, FatPer100g: 0.9, FiberPer100g: 0},
		{Name: "Meat pie", Provenance: ProvenanceUserEstimate, ServingDesc: "1 pie (175g)", ServingGrams: 175, KcalPer100g: 268, ProteinPer100g: 8, CarbsPer100g: 24, FatPer100g: 16, FiberPer100g: 1.5},
		{Name: "Sausage roll", Provenance: ProvenanceUserEstimate, ServingDesc: "1 roll (130g)", ServingGrams: 130, KcalPer100g: 312, ProteinPer100g: 8, CarbsPer100g: 24, FatPer100g: 21, FiberPer100g: 1},
		{Name: "Peanut M&M's", Brand: "Mars", Provenance: ProvenanceOFF, Barcode: ptr("040000004402"), ServingDesc: "45g pack", ServingGrams: 45, KcalPer100g: 510, ProteinPer100g: 9.5, CarbsPer100g: 57, FatPer100g: 26, FiberPer100g: 3},
		{Name: "Cavendish banana bread", Provenance: ProvenanceUserEstimate, ServingDesc: "1 slice (110g)", ServingGrams: 110, KcalPer100g: 326, ProteinPer100g: 5, CarbsPer100g: 54, FatPer100g: 10, FiberPer100g: 2},
		{Name: "Chicken caesar salad", Provenance: ProvenanceUserEstimate, ServingDesc: "1 bowl (300g)", ServingGrams: 300, KcalPer100g: 140, ProteinPer100g: 11, CarbsPer100g: 6, FatPer100g: 8, FiberPer100g: 1.5},
		{Name: "Protein shake, whey + water", Provenance: ProvenanceUserEstimate, ServingDesc: "1 scoop (30g)", ServingGrams: 30, KcalPer100g: 400, ProteinPer100g: 80, CarbsPer100g: 8, FatPer100g: 6, FiberPer100g: 1},
		{Name: "Baked beans", Brand: "Heinz", Provenance: ProvenanceOFF, Barcode: ptr("9300657000015"), ServingDesc: "1/2 can (110g)", ServingGrams: 110, KcalPer100g: 78, ProteinPer100g: 4.8, CarbsPer100g: 13, FatPer100g: 0.2, FiberPer100g: 3.8},
		{Name: "Spaghetti bolognese", Provenance: ProvenanceUserEstimate, ServingDesc: "1 plate (350g)", ServingGrams: 350, KcalPer100g: 130, ProteinPer100g: 7, CarbsPer100g: 15, FatPer100g: 4.5, FiberPer100g: 1.8},
		{Name: "Caesar wrap, chicken", Provenance: ProvenanceUserEstimate, ServingDesc: "1 wrap (250g)", ServingGrams: 250, KcalPer100g: 210, ProteinPer100g: 12, CarbsPer100g: 20, FatPer100g: 9, FiberPer100g: 2},
		{Name: "Orange", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (131g)", ServingGrams: 131, KcalPer100g: 47, ProteinPer100g: 0.9, CarbsPer100g: 12, FatPer100g: 0.1, FiberPer100g: 2.4},
		{Name: "Blueberries", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (74g)", ServingGrams: 74, KcalPer100g: 57, ProteinPer100g: 0.7, CarbsPer100g: 14, FatPer100g: 0.3, FiberPer100g: 2.4},
		{Name: "Spinach, raw", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (30g)", ServingGrams: 30, KcalPer100g: 23, ProteinPer100g: 2.9, CarbsPer100g: 3.6, FatPer100g: 0.4, FiberPer100g: 2.2},
		{Name: "Carrot, raw", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (61g)", ServingGrams: 61, KcalPer100g: 41, ProteinPer100g: 0.9, CarbsPer100g: 10, FatPer100g: 0.2, FiberPer100g: 2.8},
		{Name: "Lentils, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (99g)", ServingGrams: 99, KcalPer100g: 116, ProteinPer100g: 9, CarbsPer100g: 20, FatPer100g: 0.4, FiberPer100g: 7.9},
		{Name: "Chickpeas, canned", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (120g)", ServingGrams: 120, KcalPer100g: 139, ProteinPer100g: 7.4, CarbsPer100g: 22, FatPer100g: 2.6, FiberPer100g: 6.4},
		{Name: "Pork sausage, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 sausage (60g)", ServingGrams: 60, KcalPer100g: 297, ProteinPer100g: 16, CarbsPer100g: 2, FatPer100g: 25, FiberPer100g: 0},
		{Name: "Bacon, cooked", Provenance: ProvenanceAFCD, ServingDesc: "2 rashers (50g)", ServingGrams: 50, KcalPer100g: 468, ProteinPer100g: 37, CarbsPer100g: 1.4, FatPer100g: 35, FiberPer100g: 0},
		{Name: "Butter", Provenance: ProvenanceAFCD, ServingDesc: "1 tsp (5g)", ServingGrams: 5, KcalPer100g: 717, ProteinPer100g: 0.9, CarbsPer100g: 0.1, FatPer100g: 81, FiberPer100g: 0},
		{Name: "Olive oil", Provenance: ProvenanceAFCD, ServingDesc: "1 tbsp (14g)", ServingGrams: 14, KcalPer100g: 884, ProteinPer100g: 0, CarbsPer100g: 0, FatPer100g: 100, FiberPer100g: 0},
		{Name: "Honey", Provenance: ProvenanceAFCD, ServingDesc: "1 tbsp (21g)", ServingGrams: 21, KcalPer100g: 304, ProteinPer100g: 0.3, CarbsPer100g: 82, FatPer100g: 0, FiberPer100g: 0.2},
		{Name: "Pasta, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (140g)", ServingGrams: 140, KcalPer100g: 158, ProteinPer100g: 5.8, CarbsPer100g: 31, FatPer100g: 0.9, FiberPer100g: 1.8},
		{Name: "Quinoa, cooked", Provenance: ProvenanceAFCD, ServingDesc: "1 cup (185g)", ServingGrams: 185, KcalPer100g: 120, ProteinPer100g: 4.4, CarbsPer100g: 21, FatPer100g: 1.9, FiberPer100g: 2.8},
		{Name: "Cottage cheese", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (113g)", ServingGrams: 113, KcalPer100g: 98, ProteinPer100g: 11, CarbsPer100g: 3.4, FatPer100g: 4.3, FiberPer100g: 0},
		{Name: "Hummus", Provenance: ProvenanceAFCD, ServingDesc: "2 tbsp (30g)", ServingGrams: 30, KcalPer100g: 166, ProteinPer100g: 8, CarbsPer100g: 14, FatPer100g: 10, FiberPer100g: 6},
		{Name: "Prawns, cooked", Provenance: ProvenanceAFCD, ServingDesc: "100g", ServingGrams: 100, KcalPer100g: 99, ProteinPer100g: 24, CarbsPer100g: 0.2, FatPer100g: 0.3, FiberPer100g: 0},
		{Name: "Tofu, firm", Provenance: ProvenanceAFCD, ServingDesc: "100g", ServingGrams: 100, KcalPer100g: 144, ProteinPer100g: 17, CarbsPer100g: 2.8, FatPer100g: 8.7, FiberPer100g: 2.3},
		{Name: "Muesli, toasted", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (55g)", ServingGrams: 55, KcalPer100g: 450, ProteinPer100g: 9, CarbsPer100g: 60, FatPer100g: 18, FiberPer100g: 7},
		{Name: "Kombucha", Provenance: ProvenanceUserEstimate, ServingDesc: "1 can (330ml)", ServingGrams: 330, KcalPer100g: 12, ProteinPer100g: 0, CarbsPer100g: 3, FatPer100g: 0, FiberPer100g: 0},
		{Name: "Dark chocolate 70%", Provenance: ProvenanceAFCD, ServingDesc: "2 squares (20g)", ServingGrams: 20, KcalPer100g: 598, ProteinPer100g: 7.8, CarbsPer100g: 46, FatPer100g: 43, FiberPer100g: 11},
		{Name: "Cashews", Provenance: ProvenanceAFCD, ServingDesc: "30g handful", ServingGrams: 30, KcalPer100g: 553, ProteinPer100g: 18, CarbsPer100g: 30, FatPer100g: 44, FiberPer100g: 3.3},
		{Name: "Sushi, salmon roll", Provenance: ProvenanceUserEstimate, ServingDesc: "6 pieces (170g)", ServingGrams: 170, KcalPer100g: 145, ProteinPer100g: 6, CarbsPer100g: 24, FatPer100g: 2.5, FiberPer100g: 1.5},
		{Name: "Beef steak, grilled", Provenance: ProvenanceAFCD, ServingDesc: "1 steak (200g)", ServingGrams: 200, KcalPer100g: 271, ProteinPer100g: 26, CarbsPer100g: 0, FatPer100g: 18, FiberPer100g: 0},
		{Name: "Cucumber", Provenance: ProvenanceAFCD, ServingDesc: "1/2 cup (60g)", ServingGrams: 60, KcalPer100g: 15, ProteinPer100g: 0.7, CarbsPer100g: 3.6, FatPer100g: 0.1, FiberPer100g: 0.5},
		{Name: "Tomato", Provenance: ProvenanceAFCD, ServingDesc: "1 medium (123g)", ServingGrams: 123, KcalPer100g: 18, ProteinPer100g: 0.9, CarbsPer100g: 3.9, FatPer100g: 0.2, FiberPer100g: 1.2},
		{Name: "Mixed nuts", Provenance: ProvenanceAFCD, ServingDesc: "30g handful", ServingGrams: 30, KcalPer100g: 607, ProteinPer100g: 20, CarbsPer100g: 21, FatPer100g: 54, FiberPer100g: 8},
		{Name: "Iced latte, full cream", Provenance: ProvenanceUserEstimate, ServingDesc: "regular (350ml)", ServingGrams: 350, KcalPer100g: 42, ProteinPer100g: 2.2, CarbsPer100g: 3.3, FatPer100g: 2.3, FiberPer100g: 0},
	}
}
```

- [ ] **Step 3: Write failing repository test** — `api/internal/nutrition/repository_test.go`

```go
package nutrition

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
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

func TestSeedIsIdempotentAndSearchable(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE provenance IN ('afcd','off','user_estimate')") })

	n1, err := Seed(context.Background(), repo)
	require.NoError(t, err)
	require.Greater(t, n1, 40)

	// Second run inserts nothing new.
	n2, err := Seed(context.Background(), repo)
	require.NoError(t, err)
	require.Equal(t, 0, n2)

	results, err := repo.Search(context.Background(), "chicken", 10)
	require.NoError(t, err)
	require.NotEmpty(t, results)
	require.Contains(t, results[0].Name, "chicken")
}
```

Note: `Search` must be case-insensitive; `"chicken"` should match "Grilled chicken breast". Assert on lowercase containment — adjust the assertion to `require.Contains(t, strings.ToLower(results[0].Name), "chicken")` and import `strings`.

- [ ] **Step 4: Run — verify fail**

Run: `cd api && go test ./internal/nutrition/ -v`
Expected: FAIL (package/functions missing).

- [ ] **Step 5: Implement repository** — `api/internal/nutrition/repository.go`

```go
package nutrition

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

const searchLimitMax = 25

func (r Repository) Search(ctx context.Context, query string, limit int) ([]FoodItem, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	pattern := "%" + query + "%"
	var items []FoodItem
	err := r.db.WithContext(ctx).
		Where("name ILIKE ? OR brand ILIKE ?", pattern, pattern).
		Order("name ASC").
		Limit(limit).
		Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("nutrition: search: %w", err)
	}
	return items, nil
}

func (r Repository) GetByID(ctx context.Context, id uuid.UUID) (FoodItem, error) {
	var item FoodItem
	if err := r.db.WithContext(ctx).First(&item, "id = ?", id).Error; err != nil {
		return FoodItem{}, fmt.Errorf("nutrition: get by id: %w", err)
	}
	return item, nil
}

func (r Repository) Count(ctx context.Context) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&FoodItem{}).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("nutrition: count: %w", err)
	}
	return n, nil
}

// Insert adds items that are not already present (matched by name+brand).
func (r Repository) Insert(ctx context.Context, items []FoodItem) (int, error) {
	inserted := 0
	for _, item := range items {
		var count int64
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("name = ? AND brand = ?", item.Name, item.Brand).
			Count(&count).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert check: %w", err)
		}
		if count > 0 {
			continue
		}
		created := item
		if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert: %w", err)
		}
		inserted++
	}
	return inserted, nil
}
```

- [ ] **Step 6: Implement seed + ingester** — `api/internal/nutrition/seed.go`

```go
package nutrition

import "context"

// Ingester is a source of FoodItems for the local index. External-source
// implementations (AFCD, OpenFoodFacts, USDA dumps) land in Phase 1b; for now
// SeedIngester provides a curated dev set.
type Ingester interface {
	Name() string
	Fetch(ctx context.Context) ([]FoodItem, error)
}

type SeedIngester struct{}

func (SeedIngester) Name() string { return "seed" }

func (SeedIngester) Fetch(_ context.Context) ([]FoodItem, error) {
	return SeedItems(), nil
}

// Seed idempotently loads the curated dev food set. Returns count inserted.
func Seed(ctx context.Context, repo Repository) (int, error) {
	items, err := SeedIngester{}.Fetch(ctx)
	if err != nil {
		return 0, err
	}
	return repo.Insert(ctx, items)
}
```

- [ ] **Step 7: Implement seed binary** — `api/cmd/seed/main.go`

```go
package main

import (
	"context"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("seed: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	n, err := nutrition.Seed(context.Background(), nutrition.NewRepository(db))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("seed: inserted %d food items", n)
}
```

- [ ] **Step 8: Run — verify pass + seed locally**

Run: `cd api && go test ./internal/nutrition/ -v && DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/seed`
Expected: tests PASS; seed logs "inserted N food items" (N≥40 first run, 0 on re-run).

- [ ] **Step 9: Commit**

```bash
git add api/internal/nutrition api/cmd/seed
git commit -m "feat: nutrition food-item model, repository, dev seed and ingester skeleton"
```

---

### Task 4: Onboarding — TDEE/macro calculation + endpoint

**Files:**
- Create: `api/internal/onboarding/calc.go`, `api/internal/onboarding/calc_test.go`, `api/internal/onboarding/handler.go`
- Modify: `api/internal/user/repository.go` (add `SaveOnboarding`), `api/internal/server/router.go`

**Interfaces:**
- Consumes: `user.Repository`, auth middleware `uid`.
- Produces:
  - `onboarding.Input{Sex string; BirthYear int; HeightCm, WeightKg float64; ActivityLevel, Goal string}` and `onboarding.Targets{Kcal, ProteinG, CarbsG, FatG float64}`.
  - `onboarding.Calculate(in Input, currentYear int) (Targets, error)` — Mifflin-St Jeor BMR × activity factor, goal adjustment, macro split. Validates enums + positive metrics.
  - `user.Repository.SaveOnboarding(ctx, userID uuid.UUID, in OnboardingFields) (User, error)` where `OnboardingFields` mirrors Input + Targets + sets `onboarded_at=now()`.
  - `POST /v1/onboarding` (auth) → body = Input JSON → computes + saves → `{"data": User}`.

- [ ] **Step 1: Write failing calc tests** — `api/internal/onboarding/calc_test.go`

```go
package onboarding

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func approx(t *testing.T, want, got, tol float64) {
	t.Helper()
	require.LessOrEqual(t, math.Abs(want-got), tol, "want ~%.1f got %.1f", want, got)
}

func TestCalculateMaleMaintenance(t *testing.T) {
	// 30yo male (born 1995 given year 2025), 180cm, 80kg, moderate, maintenance.
	// BMR = 10*80 + 6.25*180 - 5*30 + 5 = 1780; TDEE = 1780*1.55 = 2759.
	got, err := Calculate(Input{Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80, ActivityLevel: "moderate", Goal: "maintenance"}, 2025)
	require.NoError(t, err)
	approx(t, 2759, got.Kcal, 5)
	// protein 2.0 g/kg = 160g
	approx(t, 160, got.ProteinG, 1)
}

func TestCalculateFemaleFatLoss(t *testing.T) {
	// 25yo female, 165cm, 65kg, light, fat_loss.
	// BMR = 10*65 + 6.25*165 - 5*25 - 161 = 1395.25; TDEE = *1.375 = 1918.47; fat_loss -500 = 1418.
	got, err := Calculate(Input{Sex: "female", BirthYear: 2000, HeightCm: 165, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.NoError(t, err)
	approx(t, 1418, got.Kcal, 5)
}

func TestCalculateRejectsBadInput(t *testing.T) {
	_, err := Calculate(Input{Sex: "other", BirthYear: 2000, HeightCm: 165, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.Error(t, err)
	_, err = Calculate(Input{Sex: "male", BirthYear: 2000, HeightCm: 0, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.Error(t, err)
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/onboarding/ -v`
Expected: FAIL (package missing).

- [ ] **Step 3: Implement calc** — `api/internal/onboarding/calc.go`

```go
// Package onboarding computes energy and macro targets from user metrics.
package onboarding

import "fmt"

type Input struct {
	Sex           string  `json:"sex"`
	BirthYear     int     `json:"birth_year"`
	HeightCm      float64 `json:"height_cm"`
	WeightKg      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
}

type Targets struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

var activityFactors = map[string]float64{
	"sedentary":   1.2,
	"light":       1.375,
	"moderate":    1.55,
	"active":      1.725,
	"very_active": 1.9,
}

var goalAdjustments = map[string]float64{
	"fat_loss":    -500,
	"maintenance": 0,
	"muscle_gain": 300,
}

func Calculate(in Input, currentYear int) (Targets, error) {
	if in.Sex != "male" && in.Sex != "female" {
		return Targets{}, fmt.Errorf("onboarding: sex must be male or female")
	}
	if in.HeightCm <= 0 || in.WeightKg <= 0 {
		return Targets{}, fmt.Errorf("onboarding: height and weight must be positive")
	}
	age := currentYear - in.BirthYear
	if age <= 0 || age > 120 {
		return Targets{}, fmt.Errorf("onboarding: birth_year out of range")
	}
	factor, ok := activityFactors[in.ActivityLevel]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid activity_level")
	}
	adjust, ok := goalAdjustments[in.Goal]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid goal")
	}

	bmr := 10*in.WeightKg + 6.25*in.HeightCm - 5*float64(age)
	if in.Sex == "male" {
		bmr += 5
	} else {
		bmr -= 161
	}
	kcal := bmr*factor + adjust

	proteinG := 2.0 * in.WeightKg          // 2 g/kg bodyweight
	fatG := (kcal * 0.25) / 9              // 25% of calories from fat
	carbsG := (kcal - proteinG*4 - fatG*9) / 4
	if carbsG < 0 {
		carbsG = 0
	}

	return Targets{Kcal: kcal, ProteinG: proteinG, CarbsG: carbsG, FatG: fatG}, nil
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd api && go test ./internal/onboarding/ -v`
Expected: PASS.

- [ ] **Step 5: Add `SaveOnboarding` to `user.Repository`** — append to `api/internal/user/repository.go`

```go
type OnboardingFields struct {
	Sex            string
	BirthYear      int
	HeightCm       float64
	WeightKg       float64
	ActivityLevel  string
	Goal           string
	TargetKcal     float64
	TargetProteinG float64
	TargetCarbsG   float64
	TargetFatG     float64
}

func (r Repository) SaveOnboarding(ctx context.Context, userID uuid.UUID, f OnboardingFields) (User, error) {
	updates := map[string]any{
		"sex":              f.Sex,
		"birth_year":       f.BirthYear,
		"height_cm":        f.HeightCm,
		"weight_kg":        f.WeightKg,
		"activity_level":   f.ActivityLevel,
		"goal":             f.Goal,
		"target_kcal":      f.TargetKcal,
		"target_protein_g": f.TargetProteinG,
		"target_carbs_g":   f.TargetCarbsG,
		"target_fat_g":     f.TargetFatG,
		"onboarded_at":     gorm.Expr("now()"),
	}
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", userID).Updates(updates).Error; err != nil {
		return User{}, fmt.Errorf("user: save onboarding: %w", err)
	}
	var out User
	if err := r.db.WithContext(ctx).First(&out, "id = ?", userID).Error; err != nil {
		return User{}, fmt.Errorf("user: fetch after onboarding: %w", err)
	}
	return out, nil
}
```

Add `"gorm.io/gorm"` to imports if not present.

- [ ] **Step 6: Implement handler** — `api/internal/onboarding/handler.go`

```go
package onboarding

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	users user.Repository
	now   func() time.Time
}

func NewHandler(users user.Repository) Handler {
	return Handler{users: users, now: time.Now}
}

func (h Handler) Submit(c *gin.Context) {
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var in Input
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed onboarding body")
		return
	}
	targets, err := Calculate(in, h.now().Year())
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	userID, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return
	}
	saved, err := h.users.SaveOnboarding(c.Request.Context(), userID, user.OnboardingFields{
		Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
		ActivityLevel: in.ActivityLevel, Goal: in.Goal,
		TargetKcal: targets.Kcal, TargetProteinG: targets.ProteinG,
		TargetCarbsG: targets.CarbsG, TargetFatG: targets.FatG,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save onboarding")
		return
	}
	httpx.OK(c, saved)
}
```

- [ ] **Step 7: Wire route** — in `api/internal/server/router.go`, inside the `if deps.DB != nil && deps.Verifier != nil` block, after the `/me` route:

```go
		userRepo := user.NewRepository(deps.DB)
		onboardingHandler := onboarding.NewHandler(userRepo)
		v1.POST("/onboarding", onboardingHandler.Submit)
```

(Refactor the existing block to build `userRepo` once and pass it to both `user.NewHandler(userRepo)` and the onboarding handler; import `onboarding`.)

- [ ] **Step 8: Run full suite**

Run: `cd api && go test ./... `
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add api/internal/onboarding api/internal/user api/internal/server
git commit -m "feat: onboarding tdee/macro calculation and endpoint"
```

---

### Task 5: `foodlog` package — log CRUD, copy-day, repeat-meal

**Files:**
- Create: `api/internal/foodlog/model.go`, `api/internal/foodlog/repository.go`, `api/internal/foodlog/service.go`, `api/internal/foodlog/handler.go`, `api/internal/foodlog/service_test.go`, `api/internal/foodlog/handler_test.go`
- Modify: `api/internal/server/router.go`

**Interfaces:**
- Consumes: `nutrition.Repository` (GetByID), `user.Repository` (IDByFirebaseUID), auth `uid`.
- Produces:
  - `foodlog.FoodLog` model (table `food_logs`) with all Task 2 columns, JSON-tagged; `UserID` is `json:"-"`.
  - `foodlog.Repository`: `Create(ctx, log FoodLog) (FoodLog, error)`, `ListByUserAndDay(ctx, userID uuid.UUID, day time.Time, loc *time.Location) ([]FoodLog, error)`, `Delete(ctx, userID, logID uuid.UUID) error`, `GetByID(ctx, userID, logID uuid.UUID) (FoodLog, error)`.
  - `foodlog.Service.LogFood(ctx, userID uuid.UUID, req LogRequest) (FoodLog, error)` — resolves the food item, computes macros from `quantity_grams`, sets provenance, persists. `LogRequest{FoodItemID *uuid.UUID; Description string; MealSlot, Source string; QuantityGrams float64; LoggedAt time.Time; ClientLogMs *int}`. When `FoodItemID` is nil it's an ad-hoc estimate (provenance `user_estimate`, macros 0 unless later supplied — Phase 1a requires a FoodItemID for manual logs; ad-hoc is Phase 3).
  - `foodlog.Service.CopyDay(ctx, userID uuid.UUID, from, to time.Time) (int, error)` — re-creates every log from `from`'s day onto `to`'s day (new IDs, `logged_at` shifted to `to`, source unchanged).
  - `foodlog.Service.RepeatLog(ctx, userID, logID uuid.UUID, at time.Time) (FoodLog, error)` — clones one log to a new time.
  - Routes (all auth): `POST /v1/logs`, `GET /v1/logs?date=YYYY-MM-DD`, `DELETE /v1/logs/:id`, `POST /v1/logs/copy-day` (`{from, to}`), `POST /v1/logs/:id/repeat` (`{at}`).

- [ ] **Step 1: Write model** — `api/internal/foodlog/model.go`

```go
// Package foodlog owns logged food-consumption events.
package foodlog

import (
	"time"

	"github.com/google/uuid"
)

type FoodLog struct {
	ID           uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID       uuid.UUID  `json:"-"`
	FoodItemID   *uuid.UUID `json:"food_item_id,omitempty"`
	LoggedAt     time.Time  `json:"logged_at"`
	MealSlot     string     `json:"meal_slot"`
	Source       string     `json:"source"`
	Description  string     `json:"description"`
	QuantityGrams float64   `json:"quantity_grams"`
	Kcal         float64    `json:"kcal"`
	ProteinG     float64    `json:"protein_g"`
	CarbsG       float64    `json:"carbs_g"`
	FatG         float64    `json:"fat_g"`
	FiberG       float64    `json:"fiber_g"`
	Provenance   string     `json:"provenance"`
	ClientLogMs  *int       `json:"client_log_ms,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}
```

- [ ] **Step 2: Write repository** — `api/internal/foodlog/repository.go`

```go
package foodlog

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) Create(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create: %w", err)
	}
	return created, nil
}

// ListByUserAndDay returns logs whose logged_at falls on `day` in location `loc`.
func (r Repository) ListByUserAndDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) ([]FoodLog, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	var logs []FoodLog
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, start, end).
		Order("logged_at ASC").
		Find(&logs).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: list by day: %w", err)
	}
	return logs, nil
}

func (r Repository) GetByID(ctx context.Context, userID, logID uuid.UUID) (FoodLog, error) {
	var log FoodLog
	if err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		First(&log).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: get by id: %w", err)
	}
	return log, nil
}

func (r Repository) Delete(ctx context.Context, userID, logID uuid.UUID) error {
	res := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		Delete(&FoodLog{})
	if res.Error != nil {
		return fmt.Errorf("foodlog: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("foodlog: delete: not found")
	}
	return nil
}
```

- [ ] **Step 3: Write failing service test** — `api/internal/foodlog/service_test.go`

```go
package foodlog

import (
	"context"
	"os"
	"testing"
	"time"

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

// seedUser inserts a bare user row and returns its id.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "fl-"+id.String(), "fl@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func TestLogFoodComputesMacrosFromGrams(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	// Insert a known food: 100 kcal/100g, 10g protein/100g.
	item := nutrition.FoodItem{Name: "Test Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 200, LoggedAt: time.Now(),
	})
	require.NoError(t, err)
	require.Equal(t, 200.0, log.Kcal)   // 100/100g * 200g
	require.Equal(t, 20.0, log.ProteinG) // 10/100g * 200g
	require.Equal(t, nutrition.ProvenanceAFCD, log.Provenance)
}

func TestCopyDayClonesLogsToNewDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Copy Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	day1 := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 1, 11, 8, 0, 0, 0, time.UTC)
	_, err := svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: day1})
	require.NoError(t, err)

	n, err := svc.CopyDay(context.Background(), userID, day1, day2, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	logs, err := NewRepository(db).ListByUserAndDay(context.Background(), userID, day2, time.UTC)
	require.NoError(t, err)
	require.Len(t, logs, 1)
}
```

- [ ] **Step 4: Run — verify fail**

Run: `cd api && go test ./internal/foodlog/ -v`
Expected: FAIL (`NewService`, `LogRequest` undefined).

- [ ] **Step 5: Implement service** — `api/internal/foodlog/service.go`

```go
package foodlog

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type LogRequest struct {
	FoodItemID    *uuid.UUID `json:"food_item_id"`
	Description   string     `json:"description"`
	MealSlot      string     `json:"meal_slot"`
	Source        string     `json:"source"`
	QuantityGrams float64    `json:"quantity_grams"`
	LoggedAt      time.Time  `json:"logged_at"`
	ClientLogMs   *int       `json:"client_log_ms"`
}

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

type Service struct {
	logs  Repository
	foods nutrition.Repository
}

func NewService(logs Repository, foods nutrition.Repository) Service {
	return Service{logs: logs, foods: foods}
}

func (s Service) LogFood(ctx context.Context, userID uuid.UUID, req LogRequest) (FoodLog, error) {
	if !validMealSlots[req.MealSlot] {
		return FoodLog{}, fmt.Errorf("foodlog: invalid meal_slot")
	}
	if req.QuantityGrams <= 0 {
		return FoodLog{}, fmt.Errorf("foodlog: quantity_grams must be positive")
	}
	if req.FoodItemID == nil {
		return FoodLog{}, fmt.Errorf("foodlog: food_item_id required in phase 1")
	}
	item, err := s.foods.GetByID(ctx, *req.FoodItemID)
	if err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: resolve food: %w", err)
	}
	f := req.QuantityGrams / 100.0
	source := req.Source
	if source == "" {
		source = "manual"
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	log := FoodLog{
		UserID:        userID,
		FoodItemID:    req.FoodItemID,
		LoggedAt:      loggedAt,
		MealSlot:      req.MealSlot,
		Source:        source,
		Description:   item.Name,
		QuantityGrams: req.QuantityGrams,
		Kcal:          item.KcalPer100g * f,
		ProteinG:      item.ProteinPer100g * f,
		CarbsG:        item.CarbsPer100g * f,
		FatG:          item.FatPer100g * f,
		FiberG:        item.FiberPer100g * f,
		Provenance:    item.Provenance,
		ClientLogMs:   req.ClientLogMs,
	}
	return s.logs.Create(ctx, log)
}

func (s Service) CopyDay(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (int, error) {
	src, err := s.logs.ListByUserAndDay(ctx, userID, from, loc)
	if err != nil {
		return 0, err
	}
	dayDelta := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc).
		Sub(time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc))
	count := 0
	for _, l := range src {
		clone := l
		clone.ID = uuid.Nil
		clone.CreatedAt = time.Time{}
		clone.LoggedAt = l.LoggedAt.Add(dayDelta)
		if _, err := s.logs.Create(ctx, clone); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (s Service) RepeatLog(ctx context.Context, userID, logID uuid.UUID, at time.Time) (FoodLog, error) {
	src, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return FoodLog{}, err
	}
	clone := src
	clone.ID = uuid.Nil
	clone.CreatedAt = time.Time{}
	clone.LoggedAt = at
	return s.logs.Create(ctx, clone)
}
```

- [ ] **Step 6: Run — verify pass**

Run: `cd api && go test ./internal/foodlog/ -run 'TestLogFood|TestCopyDay' -v`
Expected: PASS.

- [ ] **Step 7: Implement handler** — `api/internal/foodlog/handler.go`

```go
package foodlog

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc   Service
	repo  Repository
	users user.Repository
}

func NewHandler(svc Service, repo Repository, users user.Repository) Handler {
	return Handler{svc: svc, repo: repo, users: users}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	id, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req LogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed log body")
		return
	}
	log, err := h.svc.LogFood(c.Request.Context(), userID, req)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": log})
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	day, err := time.Parse("2006-01-02", c.Query("date"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
		return
	}
	logs, err := h.repo.ListByUserAndDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not list logs")
		return
	}
	httpx.OK(c, logs)
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	if err := h.repo.Delete(c.Request.Context(), userID, logID); err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}

type copyDayRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (h Handler) CopyDay(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req copyDayRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	from, err1 := time.Parse("2006-01-02", req.From)
	to, err2 := time.Parse("2006-01-02", req.To)
	if err1 != nil || err2 != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "from/to must be YYYY-MM-DD")
		return
	}
	n, err := h.svc.CopyDay(c.Request.Context(), userID, from, to, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not copy day")
		return
	}
	httpx.OK(c, gin.H{"copied": n})
}

type repeatRequest struct {
	At time.Time `json:"at"`
}

func (h Handler) Repeat(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	var req repeatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	at := req.At
	if at.IsZero() {
		at = time.Now()
	}
	log, err := h.svc.RepeatLog(c.Request.Context(), userID, logID, at)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": log})
}
```

- [ ] **Step 8: Write handler smoke test** — `api/internal/foodlog/handler_test.go` (exercises POST then GET through the gin stack with a static-uid middleware and a seeded user + food)

```go
package foodlog

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/user"
)

func TestCreateAndListLog(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)

	// Seed a user with a known firebase uid and a food item.
	fuid := "handler-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "h@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	item := nutrition.FoodItem{Name: "Handler Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	h := NewHandler(NewService(repo, nutrition.NewRepository(db)), repo, uRepo)

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Next() })
	r.POST("/v1/logs", h.Create)
	r.GET("/v1/logs", h.List)

	body, _ := json.Marshal(LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 150, LoggedAt: time.Now()})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	today := time.Now().UTC().Format("2006-01-02")
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodGet, "/v1/logs?date="+today, nil)
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusOK, w2.Code)
	require.Contains(t, w2.Body.String(), `"meal_slot":"lunch"`)
}
```

- [ ] **Step 9: Wire routes** — in `api/internal/server/router.go`, inside the auth block:

```go
		foodRepo := nutrition.NewRepository(deps.DB)
		logRepo := foodlog.NewRepository(deps.DB)
		logHandler := foodlog.NewHandler(foodlog.NewService(logRepo, foodRepo), logRepo, userRepo)
		v1.POST("/logs", logHandler.Create)
		v1.GET("/logs", logHandler.List)
		v1.DELETE("/logs/:id", logHandler.Delete)
		v1.POST("/logs/copy-day", logHandler.CopyDay)
		v1.POST("/logs/:id/repeat", logHandler.Repeat)
```

(import `foodlog` and `nutrition`.)

- [ ] **Step 10: Run full suite + commit**

Run: `cd api && go test ./... `
Expected: PASS.

```bash
git add api/internal/foodlog api/internal/server
git commit -m "feat: food log crud with copy-day and repeat-meal"
```

---

### Task 6: Food search endpoint + dashboard aggregation endpoint

**Files:**
- Create: `api/internal/nutrition/handler.go`, `api/internal/dashboard/service.go`, `api/internal/dashboard/service_test.go`, `api/internal/dashboard/handler.go`, `api/internal/tracking/model.go`, `api/internal/tracking/repository.go`, `api/internal/tracking/handler.go`
- Modify: `api/internal/server/router.go`

**Interfaces:**
- Produces:
  - `GET /v1/foods?q=<query>&limit=<n>` (auth) → `{"data":[FoodItem,...]}` via `nutrition.Handler.Search`.
  - `tracking.WaterEntry` model (table `water_entries`); `tracking.Repository` with `AddWater(ctx, userID, volumeML, at)` and `WaterTotalForDay(ctx, userID, day, loc) (int, error)`; `POST /v1/water` (`{volume_ml, logged_at?}`), `GET /v1/water?date=`.
  - `dashboard.Service.ForDay(ctx, userID, day, loc) (Summary, error)` where `Summary{Date string; Consumed Totals; Targets Totals; WaterML int; StreakDays int; SourceCounts map[string]int}` and `Totals{Kcal, ProteinG, CarbsG, FatG, FiberG float64}`.
  - `GET /v1/dashboard?date=YYYY-MM-DD` (auth) → `{"data": Summary}`.
  - Streak = consecutive days up to and including `day` with ≥1 food log.

- [ ] **Step 1: Implement nutrition search handler** — `api/internal/nutrition/handler.go`

```go
package nutrition

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

func (h Handler) Search(c *gin.Context) {
	q := c.Query("q")
	if len(q) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "q must be at least 2 characters")
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	items, err := h.repo.Search(c.Request.Context(), q, limit)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "search failed")
		return
	}
	httpx.OK(c, items)
}
```

- [ ] **Step 2: Implement tracking (water)** — `api/internal/tracking/model.go`

```go
// Package tracking owns water and weight entries.
package tracking

import (
	"time"

	"github.com/google/uuid"
)

type WaterEntry struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID `json:"-"`
	LoggedAt  time.Time `json:"logged_at"`
	VolumeML  int       `json:"volume_ml"`
	CreatedAt time.Time `json:"created_at"`
}
```

`api/internal/tracking/repository.go`:

```go
package tracking

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) AddWater(ctx context.Context, userID uuid.UUID, volumeML int, at time.Time) (WaterEntry, error) {
	if volumeML <= 0 {
		return WaterEntry{}, fmt.Errorf("tracking: volume_ml must be positive")
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WaterEntry{UserID: userID, VolumeML: volumeML, LoggedAt: at}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WaterEntry{}, fmt.Errorf("tracking: add water: %w", err)
	}
	return e, nil
}

func (r Repository) WaterTotalForDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (int, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	var total *int
	err := r.db.WithContext(ctx).Model(&WaterEntry{}).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, start, end).
		Select("COALESCE(SUM(volume_ml), 0)").Scan(&total).Error
	if err != nil {
		return 0, fmt.Errorf("tracking: water total: %w", err)
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}
```

`api/internal/tracking/handler.go`:

```go
package tracking

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	repo  Repository
	users user.Repository
}

func NewHandler(repo Repository, users user.Repository) Handler {
	return Handler{repo: repo, users: users}
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	id, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return uuid.Nil, false
	}
	return id, true
}

type addWaterRequest struct {
	VolumeML int       `json:"volume_ml"`
	LoggedAt time.Time `json:"logged_at"`
}

func (h Handler) Add(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req addWaterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	e, err := h.repo.AddWater(c.Request.Context(), userID, req.VolumeML, req.LoggedAt)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": e})
}

func (h Handler) DayTotal(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	day, err := time.Parse("2006-01-02", c.Query("date"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
		return
	}
	total, err := h.repo.WaterTotalForDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not total water")
		return
	}
	httpx.OK(c, gin.H{"volume_ml": total})
}
```

- [ ] **Step 3: Write failing dashboard test** — `api/internal/dashboard/service_test.go`

```go
package dashboard

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/tracking"
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

func TestForDayAggregatesConsumedAndSources(t *testing.T) {
	db := testDB(t)
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, target_kcal, target_protein_g) VALUES (?, ?, ?, ?, ?)",
		id, "dash-"+id.String(), "d@test.dev", 2000.0, 150.0).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })

	item := nutrition.FoodItem{Name: "Dash Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	day := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)
	logSvc := foodlog.NewService(foodlog.NewRepository(db), nutrition.NewRepository(db))
	_, err := logSvc.LogFood(context.Background(), id, foodlog.LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 200, LoggedAt: day})
	require.NoError(t, err)

	svc := NewService(foodlog.NewRepository(db), tracking.NewRepository(db), db)
	sum, err := svc.ForDay(context.Background(), id, day, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 200.0, sum.Consumed.Kcal)
	require.Equal(t, 2000.0, sum.Targets.Kcal)
	require.Equal(t, 1, sum.SourceCounts["manual"])
	require.Equal(t, 1, sum.StreakDays)
}
```

- [ ] **Step 4: Run — verify fail**

Run: `cd api && go test ./internal/dashboard/ -v`
Expected: FAIL.

- [ ] **Step 5: Implement dashboard service** — `api/internal/dashboard/service.go`

```go
// Package dashboard aggregates a user's daily intake against their targets.
package dashboard

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/tracking"
)

type Totals struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
	FiberG   float64 `json:"fiber_g"`
}

type Summary struct {
	Date         string         `json:"date"`
	Consumed     Totals         `json:"consumed"`
	Targets      Totals         `json:"targets"`
	WaterML      int            `json:"water_ml"`
	StreakDays   int            `json:"streak_days"`
	SourceCounts map[string]int `json:"source_counts"`
}

type Service struct {
	logs  foodlog.Repository
	water tracking.Repository
	db    *gorm.DB
}

func NewService(logs foodlog.Repository, water tracking.Repository, db *gorm.DB) Service {
	return Service{logs: logs, water: water, db: db}
}

func (s Service) ForDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (Summary, error) {
	logs, err := s.logs.ListByUserAndDay(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}
	consumed := Totals{}
	sources := map[string]int{}
	for _, l := range logs {
		consumed.Kcal += l.Kcal
		consumed.ProteinG += l.ProteinG
		consumed.CarbsG += l.CarbsG
		consumed.FatG += l.FatG
		consumed.FiberG += l.FiberG
		sources[l.Source]++
	}

	var u struct {
		TargetKcal     float64
		TargetProteinG float64
		TargetCarbsG   float64
		TargetFatG     float64
	}
	if err := s.db.WithContext(ctx).Table("users").
		Select("target_kcal, target_protein_g, target_carbs_g, target_fat_g").
		Where("id = ?", userID).Scan(&u).Error; err != nil {
		return Summary{}, fmt.Errorf("dashboard: load targets: %w", err)
	}

	waterML, err := s.water.WaterTotalForDay(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}

	streak, err := s.streakDays(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}

	return Summary{
		Date:     day.In(loc).Format("2006-01-02"),
		Consumed: consumed,
		Targets:  Totals{Kcal: u.TargetKcal, ProteinG: u.TargetProteinG, CarbsG: u.TargetCarbsG, FatG: u.TargetFatG},
		WaterML:  waterML,
		StreakDays: streak,
		SourceCounts: sources,
	}, nil
}

// streakDays counts consecutive days ending at `day` that have ≥1 food log.
func (s Service) streakDays(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (int, error) {
	streak := 0
	cursor := day
	for {
		logs, err := s.logs.ListByUserAndDay(ctx, userID, cursor, loc)
		if err != nil {
			return 0, err
		}
		if len(logs) == 0 {
			break
		}
		streak++
		cursor = cursor.Add(-24 * time.Hour)
		if streak > 3650 { // safety cap (10y)
			break
		}
	}
	return streak, nil
}
```

- [ ] **Step 6: Implement dashboard handler** — `api/internal/dashboard/handler.go`

```go
package dashboard

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc   Service
	users user.Repository
}

func NewHandler(svc Service, users user.Repository) Handler {
	return Handler{svc: svc, users: users}
}

func (h Handler) Get(c *gin.Context) {
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	userID, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return
	}
	dateStr := c.Query("date")
	day := time.Now().UTC()
	if dateStr != "" {
		parsed, perr := time.Parse("2006-01-02", dateStr)
		if perr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
			return
		}
		day = parsed
	}
	sum, err := h.svc.ForDay(c.Request.Context(), userID, day, time.UTC)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not build dashboard")
		return
	}
	httpx.OK(c, sum)
}
```

- [ ] **Step 7: Run dashboard test — verify pass**

Run: `cd api && go test ./internal/dashboard/ -v`
Expected: PASS.

- [ ] **Step 8: Wire routes** — in `api/internal/server/router.go` auth block:

```go
		nutritionHandler := nutrition.NewHandler(foodRepo)
		v1.GET("/foods", nutritionHandler.Search)

		trackingRepo := tracking.NewRepository(deps.DB)
		trackingHandler := tracking.NewHandler(trackingRepo, userRepo)
		v1.POST("/water", trackingHandler.Add)
		v1.GET("/water", trackingHandler.DayTotal)

		dashboardHandler := dashboard.NewHandler(dashboard.NewService(logRepo, trackingRepo, deps.DB), userRepo)
		v1.GET("/dashboard", dashboardHandler.Get)
```

(import `dashboard`, `tracking`; `foodRepo` and `logRepo` already exist from Task 5.)

- [ ] **Step 9: Full suite + commit**

Run: `cd api && go test ./... `
Expected: PASS.

```bash
git add api/internal/nutrition api/internal/tracking api/internal/dashboard api/internal/server
git commit -m "feat: food search, water tracking, and daily dashboard endpoints"
```

---

### Task 7: Mobile — React Query + API hooks + onboarding flow

**Files:**
- Modify: `apps/mobile/app/_layout.tsx` (add QueryClientProvider)
- Create: `apps/mobile/src/lib/queryClient.ts`, `apps/mobile/src/api/hooks.ts`, `apps/mobile/src/api/types.ts`, `apps/mobile/src/api/__tests__/hooks.test.tsx`
- Create: `apps/mobile/app/onboarding.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `src/lib/api.ts`.
- Produces:
  - `queryClient.ts`: a shared `QueryClient`.
  - `types.ts`: TS types mirroring API JSON — `Profile`, `FoodItem`, `FoodLog`, `DashboardSummary`, `OnboardingInput`.
  - `hooks.ts`: `useProfile()`, `useSubmitOnboarding()`, `useFoodSearch(q)`, `useCreateLog()`, `useDayLogs(date)`, `useDashboard(date)`, `useAddWater()`, `useCopyDay()`. Each wraps React Query over `apiFetch`.
  - `/onboarding` route: goal + metrics form → `useSubmitOnboarding` → routes to `/`.

- [ ] **Step 1: Install React Query**

Run: `cd apps/mobile && npx expo install @tanstack/react-query`

- [ ] **Step 2: Create query client** — `apps/mobile/src/lib/queryClient.ts`

```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});
```

- [ ] **Step 3: Create API types** — `apps/mobile/src/api/types.ts`

```ts
export type Profile = {
  id: string;
  email: string;
  display_name: string;
  goal: string;
  target_kcal: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  onboarded_at: string | null;
};

export type FoodItem = {
  id: string;
  name: string;
  brand: string;
  provenance: string;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
};

export type FoodLog = {
  id: string;
  food_item_id?: string;
  logged_at: string;
  meal_slot: string;
  source: string;
  description: string;
  quantity_grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  provenance: string;
};

export type Totals = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

export type DashboardSummary = {
  date: string;
  consumed: Totals;
  targets: Totals;
  water_ml: number;
  streak_days: number;
  source_counts: Record<string, number>;
};

export type OnboardingInput = {
  sex: "male" | "female";
  birth_year: number;
  height_cm: number;
  weight_kg: number;
  activity_level: "sedentary" | "light" | "moderate" | "active" | "very_active";
  goal: "fat_loss" | "maintenance" | "muscle_gain";
};
```

- [ ] **Step 4: Write failing hooks test** — `apps/mobile/src/api/__tests__/hooks.test.tsx`

```tsx
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProfile } from "../hooks";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.c", goal: "", onboarded_at: null }),
  ApiError: class extends Error {},
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

test("useProfile fetches /v1/me", async () => {
  const { result } = renderHook(() => useProfile(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.email).toBe("a@b.c");
});
```

- [ ] **Step 5: Run — verify fail**

Run: `cd apps/mobile && npm test -- hooks`
Expected: FAIL (`../hooks` missing).

- [ ] **Step 6: Implement hooks** — `apps/mobile/src/api/hooks.ts`

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  DashboardSummary,
  FoodItem,
  FoodLog,
  OnboardingInput,
  Profile,
} from "./types";

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => apiFetch("/v1/me") as Promise<Profile>,
  });
}

export function useSubmitOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingInput) =>
      apiFetch("/v1/onboarding", { method: "POST", body: JSON.stringify(input) }) as Promise<Profile>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}

export function useFoodSearch(q: string) {
  return useQuery({
    queryKey: ["foods", q],
    queryFn: () => apiFetch(`/v1/foods?q=${encodeURIComponent(q)}`) as Promise<FoodItem[]>,
    enabled: q.trim().length >= 2,
  });
}

type CreateLogInput = {
  food_item_id: string;
  meal_slot: string;
  source: string;
  quantity_grams: number;
  logged_at: string;
  client_log_ms?: number;
};

export function useCreateLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLogInput) =>
      apiFetch("/v1/logs", { method: "POST", body: JSON.stringify(input) }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDayLogs(date: string) {
  return useQuery({
    queryKey: ["logs", date],
    queryFn: () => apiFetch(`/v1/logs?date=${date}`) as Promise<FoodLog[]>,
  });
}

export function useDashboard(date: string) {
  return useQuery({
    queryKey: ["dashboard", date],
    queryFn: () => apiFetch(`/v1/dashboard?date=${date}`) as Promise<DashboardSummary>,
  });
}

export function useAddWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (volume_ml: number) =>
      apiFetch("/v1/water", { method: "POST", body: JSON.stringify({ volume_ml }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

export function useCopyDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

- [ ] **Step 7: Run — verify pass**

Run: `cd apps/mobile && npm test -- hooks`
Expected: PASS.

- [ ] **Step 8: Add provider to layout** — modify `apps/mobile/app/_layout.tsx` to wrap `Stack` in `QueryClientProvider` using `queryClient`, preserving the Task 1 config-guard effect:

```tsx
import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) {
      router.replace("/config-missing");
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }} />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 9: Build onboarding screen** — `apps/mobile/app/onboarding.tsx`

A vertical form using theme primitives: goal (3 `Button`s selecting `fat_loss`/`maintenance`/`muscle_gain`), sex (2 buttons), numeric `TextInput`s for birth_year/height_cm/weight_kg, activity level (5 buttons), a submit `Button` calling `useSubmitOnboarding().mutate(...)` and on success `router.replace("/")`. Full code:

```tsx
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";

const GOALS: OnboardingInput["goal"][] = ["fat_loss", "maintenance", "muscle_gain"];
const ACTIVITIES: OnboardingInput["activity_level"][] = ["sedentary", "light", "moderate", "active", "very_active"];

export default function Onboarding() {
  const { colors, spacing, radius } = useTheme();
  const submit = useSubmitOnboarding();
  const [goal, setGoal] = useState<OnboardingInput["goal"]>("maintenance");
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activity, setActivity] = useState<OnboardingInput["activity_level"]>("moderate");
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  function onSubmit() {
    setError(null);
    const input: OnboardingInput = {
      sex,
      goal,
      activity_level: activity,
      birth_year: Number(birthYear),
      height_cm: Number(heightCm),
      weight_kg: Number(weightKg),
    };
    submit.mutate(input, {
      onSuccess: () => router.replace("/"),
      onError: () => setError("Please check your details and try again."),
    });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Set your goal</AppText>

      <AppText variant="h3">Goal</AppText>
      <View style={{ gap: spacing.sm }}>
        {GOALS.map((g) => (
          <Button key={g} title={g.replace("_", " ")} variant={goal === g ? "primary" : "secondary"} onPress={() => setGoal(g)} />
        ))}
      </View>

      <AppText variant="h3">Sex</AppText>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}><Button title="Male" variant={sex === "male" ? "primary" : "secondary"} onPress={() => setSex("male")} /></View>
        <View style={{ flex: 1 }}><Button title="Female" variant={sex === "female" ? "primary" : "secondary"} onPress={() => setSex("female")} /></View>
      </View>

      <TextInput style={inputStyle} placeholder="Birth year (e.g. 1995)" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={birthYear} onChangeText={setBirthYear} />
      <TextInput style={inputStyle} placeholder="Height (cm)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={heightCm} onChangeText={setHeightCm} />
      <TextInput style={inputStyle} placeholder="Weight (kg)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={weightKg} onChangeText={setWeightKg} />

      <AppText variant="h3">Activity</AppText>
      <View style={{ gap: spacing.sm }}>
        {ACTIVITIES.map((a) => (
          <Button key={a} title={a.replace("_", " ")} variant={activity === a ? "primary" : "secondary"} onPress={() => setActivity(a)} />
        ))}
      </View>

      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={submit.isPending ? "Saving…" : "Continue"} onPress={onSubmit} disabled={submit.isPending} />
    </ScrollView>
  );
}
```

- [ ] **Step 10: Typecheck, test, commit**

Run: `cd apps/mobile && npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add apps/mobile
git commit -m "feat: react query api hooks and onboarding flow"
```

---

### Task 8: Mobile — home dashboard, food logging, water quick-adds

**Files:**
- Create: `apps/mobile/src/components/Ring.tsx`, `apps/mobile/src/components/MacroBar.tsx`, `apps/mobile/src/components/ProvenanceChip.tsx`, `apps/mobile/src/components/__tests__/dashboard-widgets.test.tsx`
- Create: `apps/mobile/app/log.tsx`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `useDashboard`, `useDayLogs`, `useFoodSearch`, `useCreateLog`, `useAddWater`, `useProfile` from Task 7; theme.
- Produces:
  - `<Ring value={number} max={number} label={string} />` — a calorie ring (SVG-free: layered circular views or a simple percentage arc via `react-native-svg` if available; otherwise a horizontal fallback). Use a simple approach: a labeled percentage with a filled track (no new native dep).
  - `<MacroBar label value target color />` — a labeled progress bar (protein/carbs/fat) using themed track + fill.
  - `<ProvenanceChip provenance={string} />` — small pill: `afcd/off/usda` → "verified" tone; `user_estimate/label_ocr` → "estimate" tone with `~`.
  - `/log` route: search foods, pick one, choose grams + meal slot, submit; measures client time-to-log and sends `client_log_ms`.
  - `index.tsx`: if `profile.onboarded_at` is null → redirect to `/onboarding`; else show today's dashboard (Ring + MacroBars + streak + water quick-adds + today's logs with ProvenanceChip + a "＋ Log food" button → `/log`).

- [ ] **Step 1: Write failing widget tests** — `apps/mobile/src/components/__tests__/dashboard-widgets.test.tsx`

```tsx
import { render } from "@testing-library/react-native";
import { Ring } from "../Ring";
import { MacroBar } from "../MacroBar";
import { ProvenanceChip } from "../ProvenanceChip";

test("Ring shows remaining and percentage label", async () => {
  const { getByText } = await render(<Ring value={1850} max={2200} label="kcal" />);
  expect(getByText(/1850/)).toBeTruthy();
  expect(getByText(/2200/)).toBeTruthy();
});

test("MacroBar renders label and values", async () => {
  const { getByText } = await render(<MacroBar label="Protein" value={142} target={160} color="#2D4A2B" />);
  expect(getByText("Protein")).toBeTruthy();
  expect(getByText(/142/)).toBeTruthy();
});

test("ProvenanceChip labels verified vs estimate", async () => {
  const verified = await render(<ProvenanceChip provenance="afcd" />);
  expect(verified.getByText(/verified/i)).toBeTruthy();
  const estimate = await render(<ProvenanceChip provenance="user_estimate" />);
  expect(estimate.getByText(/estimate/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd apps/mobile && npm test -- dashboard-widgets`
Expected: FAIL.

- [ ] **Step 3: Implement `Ring`** — `apps/mobile/src/components/Ring.tsx` (dependency-free: numeric center + a themed track bar underneath)

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { value: number; max: number; label: string };

export function Ring({ value, max, label }: Props) {
  const { colors, radius, spacing } = useTheme();
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <View style={{ gap: spacing.sm, alignItems: "center" }}>
      <AppText variant="h1">{Math.round(value)}</AppText>
      <AppText muted>
        of {Math.round(max)} {label} · {pct}%
      </AppText>
      <View style={{ height: 10, width: "100%", backgroundColor: colors.muted, borderRadius: radius.full }}>
        <View style={{ height: 10, width: `${pct}%`, backgroundColor: colors.primary, borderRadius: radius.full }} />
      </View>
    </View>
  );
}
```

- [ ] **Step 4: Implement `MacroBar`** — `apps/mobile/src/components/MacroBar.tsx`

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { label: string; value: number; target: number; color: string };

export function MacroBar({ label, value, target, color }: Props) {
  const { colors, radius, spacing } = useTheme();
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText>{label}</AppText>
        <AppText muted>
          {Math.round(value)} / {Math.round(target)} g
        </AppText>
      </View>
      <View style={{ height: 8, backgroundColor: colors.muted, borderRadius: radius.full }}>
        <View style={{ height: 8, width: `${pct}%`, backgroundColor: color, borderRadius: radius.full }} />
      </View>
    </View>
  );
}
```

- [ ] **Step 5: Implement `ProvenanceChip`** — `apps/mobile/src/components/ProvenanceChip.tsx`

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

const VERIFIED = new Set(["afcd", "off", "usda"]);

export function ProvenanceChip({ provenance }: { provenance: string }) {
  const { colors, radius, spacing } = useTheme();
  const isVerified = VERIFIED.has(provenance);
  const label = isVerified ? `${provenance.toUpperCase()} · verified` : "AI estimate ±15%";
  const bg = isVerified ? colors.secondary : colors.muted;
  const fg = isVerified ? colors.secondaryForeground : colors.mutedForeground;
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: bg, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2 }}>
      <AppText style={{ color: fg, fontSize: 12 }}>{label}</AppText>
    </View>
  );
}
```

- [ ] **Step 6: Run widget tests — verify pass**

Run: `cd apps/mobile && npm test -- dashboard-widgets`
Expected: PASS.

- [ ] **Step 7: Build the log screen** — `apps/mobile/app/log.tsx`

Search input (debounced via local state), results list (`useFoodSearch`), tapping a food opens a grams + meal-slot picker, submit calls `useCreateLog` with `client_log_ms = Date.now() - screenMountedAt`. Full code:

```tsx
import { useRef, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useCreateLog, useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export default function LogScreen() {
  const { colors, spacing, radius } = useTheme();
  const mountedAt = useRef(Date.now());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState("");
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const search = useFoodSearch(q);
  const createLog = useCreateLog();

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  function submit() {
    if (!selected) return;
    createLog.mutate(
      {
        food_item_id: selected.id,
        meal_slot: meal,
        source: "manual",
        quantity_grams: Number(grams) || selected.serving_grams || 100,
        logged_at: new Date().toISOString(),
        client_log_ms: Date.now() - mountedAt.current,
      },
      { onSuccess: () => router.replace("/") },
    );
  }

  if (selected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md }}>
        <AppText variant="h2">{selected.name}</AppText>
        <ProvenanceChip provenance={selected.provenance} />
        <TextInput style={inputStyle} placeholder={`Grams (default ${selected.serving_grams || 100})`} placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={grams} onChangeText={setGrams} />
        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {MEALS.map((m) => (
            <Button key={m} title={m} variant={meal === m ? "primary" : "secondary"} onPress={() => setMeal(m)} />
          ))}
        </View>
        <Button title={createLog.isPending ? "Logging…" : "Log it"} onPress={submit} disabled={createLog.isPending} />
        <Button title="Back" variant="ghost" onPress={() => setSelected(null)} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Log food</AppText>
      <TextInput style={inputStyle} placeholder="Search foods…" placeholderTextColor={colors.mutedForeground} autoFocus value={q} onChangeText={setQ} />
      <FlatList
        data={search.data ?? []}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)}>
            <Card>
              <AppText>{item.name}</AppText>
              <AppText muted>
                {Math.round(item.kcal_per_100g)} kcal/100g · {item.serving_desc}
              </AppText>
            </Card>
          </Pressable>
        )}
        ListEmptyComponent={q.length >= 2 && !search.isLoading ? <AppText muted>No matches.</AppText> : null}
      />
    </View>
  );
}
```

- [ ] **Step 8: Rebuild the home screen** — `apps/mobile/app/index.tsx`

Auth gate (Task 0/1 behavior) + onboarding gate + dashboard. Replace body:

```tsx
import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Ring } from "@/components/Ring";
import { MacroBar } from "@/components/MacroBar";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useAddWater, useDashboard, useDayLogs, useProfile } from "@/api/hooks";
import { useTheme } from "@/theme";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function Index() {
  const { colors, spacing } = useTheme();
  const profile = useProfile();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);
  const addWater = useAddWater();

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) router.replace("/sign-in");
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (profile.data && profile.data.onboarded_at === null) {
      router.replace("/onboarding");
    }
  }, [profile.data]);

  if (!isFirebaseConfigured) return null;

  const d = dashboard.data;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Today</AppText>

      {d ? (
        <>
          <Card>
            <Ring value={d.consumed.kcal} max={d.targets.kcal} label="kcal" />
          </Card>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <MacroBar label="Protein" value={d.consumed.protein_g} target={d.targets.protein_g} color={colors.primary} />
              <MacroBar label="Carbs" value={d.consumed.carbs_g} target={d.targets.carbs_g} color={colors.accentForeground} />
              <MacroBar label="Fat" value={d.consumed.fat_g} target={d.targets.fat_g} color={colors.mutedForeground} />
            </View>
          </Card>
          <Card>
            <AppText variant="h3">Streak</AppText>
            <AppText muted>{d.streak_days} day{d.streak_days === 1 ? "" : "s"}</AppText>
          </Card>
          <Card>
            <AppText variant="h3">Water</AppText>
            <AppText muted>{d.water_ml} ml today</AppText>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" }}>
              {[250, 500, 750].map((ml) => (
                <Button key={ml} title={`+${ml}ml`} variant="secondary" onPress={() => addWater.mutate(ml)} />
              ))}
            </View>
          </Card>
        </>
      ) : (
        <AppText muted>Loading your day…</AppText>
      )}

      <Button title="＋ Log food" onPress={() => router.push("/log")} />

      <AppText variant="h3">Logged today</AppText>
      {(logs.data ?? []).map((l) => (
        <Card key={l.id}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText>{l.description}</AppText>
            <AppText muted>{Math.round(l.kcal)} kcal</AppText>
          </View>
          <View style={{ marginTop: spacing.xs }}>
            <ProvenanceChip provenance={l.provenance} />
          </View>
        </Card>
      ))}
      {(logs.data ?? []).length === 0 ? <AppText muted>Nothing logged yet.</AppText> : null}

      <Button title="Sign out" variant="ghost" onPress={() => auth && signOut(auth)} />
    </ScrollView>
  );
}
```

- [ ] **Step 9: Typecheck, test, commit**

Run: `cd apps/mobile && npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add apps/mobile
git commit -m "feat: home dashboard, food logging screen, water quick-adds"
```

---

### Task 9: CI seed step + full-stack smoke verification

**Files:**
- Modify: `.github/workflows/ci.yml` (the `api` job already migrates; add nothing that needs external data — the seed binary is covered by `go test`).
- Create: `docs/superpowers/plans/phase-1a-verification.md` (a short manual smoke script)

**Interfaces:**
- Produces: a documented end-to-end smoke path and a green CI.

- [ ] **Step 1: Confirm CI still green with the new packages**

The `api` job runs `go test -race ./...` after migrating — the new packages' Postgres-backed tests run against the service container. Verify locally first:

Run: `cd api && go vet ./... && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/migrate && go test -race ./...`
Expected: all packages PASS with `-race`.

- [ ] **Step 2: Write the manual smoke doc** — `docs/superpowers/plans/phase-1a-verification.md`

```markdown
# Phase 1a — Manual Smoke

Prereqs: `docker compose -f infra/docker-compose.yml up -d`; Firebase project + `apps/mobile/.env` filled.

1. Migrate + seed:
   DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/migrate
   DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/seed
2. Run API: DATABASE_URL=... FIREBASE_PROJECT_ID=kora-app go run ./cmd/api
3. Run app: cd apps/mobile && npx expo start --port 8199 --ios
4. In the sim: sign up → onboarding (goal + metrics) → Continue → dashboard shows targets.
5. ＋ Log food → search "chicken" → pick → 200g → lunch → Log it → dashboard kcal/protein rise, provenance chip shows on the entry.
6. +500ml water → water total rises. Kill and reopen app → streak = 1.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml docs/superpowers/plans/phase-1a-verification.md
git commit -m "docs: phase 1a verification smoke script"
```

---

## Definition of Done (Phase 1a)

- [ ] Missing Firebase config shows the `/config-missing` screen instead of a red-box crash.
- [ ] Migration `000002` applies; `food_items`, `food_aliases`, `food_logs`, `water_entries`, `weight_entries` exist; `users` has onboarding + target columns.
- [ ] `go run ./cmd/seed` inserts the AU dev food set idempotently.
- [ ] `POST /v1/onboarding` computes Mifflin-St Jeor targets and persists them; `GET /v1/me` returns them.
- [ ] `GET /v1/foods?q=` returns matches; `POST /v1/logs` computes macros server-side from grams; `GET /v1/logs?date=` lists a day; delete, copy-day, and repeat work; backdated `logged_at` is honored.
- [ ] `POST /v1/water` + `GET /v1/dashboard` return consumed vs. targets, water total, streak, and source counts.
- [ ] Mobile: onboarding → dashboard (Ring + MacroBars + streak + water) → log a food (with provenance chip) → totals update.
- [ ] All Go tests pass with `-race`; mobile `tsc --noEmit` + `npm test` pass; CI green.
- [ ] `client_log_ms` and `source` are captured on every log (success-metric instrumentation).

## Deferred to Phase 1b (noted, not built here)

- Full food-index ingestion from AFCD + OpenFoodFacts + USDA dumps (real `Ingester` implementations replacing the seed), full-text + pgvector search replacing `ILIKE`, and the alias table populated from corrections.
- Barcode scanning UI (schema supports `barcode` now; camera flow is Phase 3's capture work).
- Offline queue for logs.
- Health-integration connect prompts in onboarding (Phase 5).
