# Food Unit Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Kora record and display a food quantity in the unit the user actually means — "1 sachet", "200 ml", "1 cup" — instead of forcing every amount into grams.

**Architecture:** A food item declares its `base_unit` (`g`/`ml`) and a list of named `serving_units` parsed from label text, with a small curated fallback table. A log stores what the user entered (`entered_amount`, `entered_unit`) alongside the canonical `quantity_grams`, which stays the sole input to every nutrition calculation. Conversion happens once at write time and is never re-run on read.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, PostgreSQL 15, testify · Expo/React Native, TypeScript, jest, @testing-library/react-native

**Spec:** `docs/superpowers/specs/2026-08-09-kora-unit-support-design.md`

## Global Constraints

- **Nutrition is computed from `quantity_grams` × the row's per-100 figures, server-side, always.** No task may introduce a nutrition figure derived on the client or supplied by an LLM.
- A unit resolves to `quantity_grams` **once, at write time**. Never re-resolve on read.
- `base_unit` is constrained to exactly `('g','ml')` at the database level.
- `entered_amount` / `entered_unit` are nullable. Null means a legacy gram-entered row and must format as grams.
- Food portions are **always metric**. `apps/mobile/src/units/convert.ts` (body weight, water) must not be modified, and the metric/imperial preference must not reach food portions.
- `ToBase` returns an error rather than guessing. No caller may substitute a default on that error path.
- Migrations are golang-migrate, numbered `000026`, both `.up.sql` and `.down.sql`, in `api/internal/database/migrations/`.
- Commits: conventional, **single-line**, no signature or attribution of any kind.
- Go tests are table-driven with testify. Run from `api/`.
- Mobile tests run from `apps/mobile/` via `npx jest <path>`.

---

### Task 1: Migration — add unit columns

**Files:**
- Create: `api/internal/database/migrations/000026_food_units.up.sql`
- Create: `api/internal/database/migrations/000026_food_units.down.sql`
- Modify: `api/internal/nutrition/model.go:38-53` (FoodItem struct)
- Modify: `api/internal/foodlog/model.go:18` (FoodLog struct)

**Interfaces:**
- Consumes: nothing
- Produces: `nutrition.FoodItem.BaseUnit string`, `nutrition.FoodItem.ServingUnits json.RawMessage`, `foodlog.FoodLog.EnteredAmount *float64`, `foodlog.FoodLog.EnteredUnit *string`

- [ ] **Step 1: Write the up migration**

Create `api/internal/database/migrations/000026_food_units.up.sql`:

```sql
-- Food unit support. Units are an ENTRY AND DISPLAY concern only: a unit
-- resolves to quantity_grams once at write time and is never re-resolved on
-- read, so correcting a density or serving mass later changes future logs
-- only and never silently rewrites what a past day's totals said.
--
-- base_unit is the unit the row's *_per_100g figures are actually per-100 OF.
-- OpenFoodFacts reports a liquid's nutriments per 100 ml already, so this is a
-- labelling fix, not a numeric conversion. The existing column names stay as
-- they are; renaming kcal_per_100g to something unit-neutral would touch every
-- service and buy nothing.
ALTER TABLE food_items ADD COLUMN base_unit text NOT NULL DEFAULT 'g';
ALTER TABLE food_items ADD CONSTRAINT food_items_base_unit_check
  CHECK (base_unit IN ('g', 'ml'));

-- Named servings, e.g. [{"name":"sachet","amount":1,"base_amount":16.5}].
-- base_amount is expressed in the row's own base_unit. `amount` is the count
-- the name refers to (almost always 1) so "2 biscuits (30g)" parses without
-- lying about what one biscuit weighs.
ALTER TABLE food_items ADD COLUMN serving_units jsonb NOT NULL DEFAULT '[]'::jsonb;

-- What the user actually entered, beside the canonical grams. NULL means a
-- legacy gram-entered row. quantity_grams keeps its exact current meaning and
-- remains the sole input to every nutrition total.
ALTER TABLE food_logs ADD COLUMN entered_amount numeric NULL;
ALTER TABLE food_logs ADD COLUMN entered_unit text NULL;

ALTER TABLE saved_meal_items ADD COLUMN entered_amount numeric NULL;
ALTER TABLE saved_meal_items ADD COLUMN entered_unit text NULL;
```

- [ ] **Step 2: Write the down migration**

Create `api/internal/database/migrations/000026_food_units.down.sql`:

```sql
-- Lossless: quantity_grams was never modified by the up migration, so every
-- nutrition total survives this rollback unchanged. What IS lost is the record
-- of what the user typed — a log entered as "1 sachet" reverts to reading as
-- its gram equivalent, which is exactly the pre-000026 behaviour.
ALTER TABLE saved_meal_items DROP COLUMN IF EXISTS entered_unit;
ALTER TABLE saved_meal_items DROP COLUMN IF EXISTS entered_amount;

ALTER TABLE food_logs DROP COLUMN IF EXISTS entered_unit;
ALTER TABLE food_logs DROP COLUMN IF EXISTS entered_amount;

ALTER TABLE food_items DROP CONSTRAINT IF EXISTS food_items_base_unit_check;
ALTER TABLE food_items DROP COLUMN IF EXISTS serving_units;
ALTER TABLE food_items DROP COLUMN IF EXISTS base_unit;
```

- [ ] **Step 3: Add the model fields**

In `api/internal/nutrition/model.go`, add `encoding/json` to the imports and add these two fields to `FoodItem`, immediately after `ServingGrams`:

```go
	BaseUnit       string          `gorm:"column:base_unit" json:"base_unit"`
	ServingUnits   json.RawMessage `gorm:"column:serving_units;type:jsonb" json:"serving_units,omitempty"`
```

In `api/internal/foodlog/model.go`, add these two fields to `FoodLog`, immediately after `QuantityGrams`:

```go
	EnteredAmount *float64 `gorm:"column:entered_amount" json:"entered_amount,omitempty"`
	EnteredUnit   *string  `gorm:"column:entered_unit" json:"entered_unit,omitempty"`
```

- [ ] **Step 4: Verify the migration applies and reverses**

Run from `api/`:

```bash
go build ./... && go vet ./internal/nutrition/ ./internal/foodlog/
```

Expected: clean. Then confirm the SQL parses by applying it against a scratch database if one is configured locally; otherwise rely on the migrate job in CI.

- [ ] **Step 5: Commit**

```bash
git add api/internal/database/migrations/000026_food_units.up.sql api/internal/database/migrations/000026_food_units.down.sql api/internal/nutrition/model.go api/internal/foodlog/model.go
git commit -m "feat(api): add unit columns to food items, logs and saved meal items"
```

---

### Task 2: `units` package — types and `Parse`

**Files:**
- Create: `api/internal/units/units.go`
- Test: `api/internal/units/units_test.go`

**Interfaces:**
- Consumes: nothing (deliberately no dependency on `nutrition` yet)
- Produces:
  - `type ServingUnit struct { Name string; Amount float64; BaseAmount float64 }` with json tags `name`, `amount`, `base_amount`
  - `func Parse(servingDesc string) ([]ServingUnit, error)`
  - `var ErrNoUnits = errors.New("units: no parseable serving unit")`

- [ ] **Step 1: Write the failing test**

Create `api/internal/units/units_test.go`:

```go
package units

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []ServingUnit
	}{
		{
			name:  "single count serving with grams",
			input: "1 cup (158g)",
			want:  []ServingUnit{{Name: "cup", Amount: 1, BaseAmount: 158}},
		},
		{
			name:  "plural count serving divides by the count",
			input: "2 biscuits (30g)",
			want:  []ServingUnit{{Name: "biscuit", Amount: 1, BaseAmount: 15}},
		},
		{
			name:  "fractional base amount is preserved",
			input: "1 sachet (16.5g)",
			want:  []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}},
		},
		{
			name:  "size adjective is kept as the unit name",
			input: "1 medium (118g)",
			want:  []ServingUnit{{Name: "medium", Amount: 1, BaseAmount: 118}},
		},
		{
			name:  "millilitre serving",
			input: "1 glass (250ml)",
			want:  []ServingUnit{{Name: "glass", Amount: 1, BaseAmount: 250}},
		},
		{
			name:  "leading-mass form with no parenthetical",
			input: "45g pack",
			want:  []ServingUnit{{Name: "pack", Amount: 1, BaseAmount: 45}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseNoUnits(t *testing.T) {
	for _, input := range []string{"", "per serving", "about a handful"} {
		t.Run(input, func(t *testing.T) {
			got, err := Parse(input)
			assert.ErrorIs(t, err, ErrNoUnits)
			assert.Nil(t, got)
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/units/ -run TestParse -v`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write the implementation**

Create `api/internal/units/units.go`:

```go
// Package units turns the serving-size text a food row already carries into
// structured, convertible serving units.
//
// Every number this package produces is traceable to a parsed label, the
// curated table, or the food row itself. Nothing here calls an LLM, and
// nothing here invents a conversion: an unknown unit is an error, never a
// guess, because a fabricated density silently corrupts every total that
// uses it while an absent one is merely recoverable.
package units

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// ErrNoUnits reports that a serving description carried no parseable unit.
// It is not a failure state — the food simply has no named serving, and the
// caller falls back to raw base-unit entry.
var ErrNoUnits = errors.New("units: no parseable serving unit")

// ServingUnit is one named serving of a food, e.g. one sachet weighing 16.5g.
// BaseAmount is expressed in the food's own base unit (g or ml).
type ServingUnit struct {
	Name       string  `json:"name"`
	Amount     float64 `json:"amount"`
	BaseAmount float64 `json:"base_amount"`
}

// parenthetical matches the dominant label form: a count, a unit name, then
// the mass or volume in brackets — "1 cup (158g)", "2 biscuits (30g)".
var parenthetical = regexp.MustCompile(`^\s*([\d.]+)\s+([a-zA-Z ]+?)\s*\(\s*([\d.]+)\s*(g|ml)\s*\)\s*$`)

// leadingMass matches the inverted form OFF sometimes uses — "45g pack".
var leadingMass = regexp.MustCompile(`^\s*([\d.]+)\s*(g|ml)\s+([a-zA-Z ]+?)\s*$`)

// Parse extracts serving units from a serving description. It returns
// ErrNoUnits when the text carries none — the common case for bare
// descriptions like "per serving".
func Parse(servingDesc string) ([]ServingUnit, error) {
	if m := parenthetical.FindStringSubmatch(servingDesc); m != nil {
		count, err := strconv.ParseFloat(m[1], 64)
		if err != nil || count <= 0 {
			return nil, ErrNoUnits
		}
		base, err := strconv.ParseFloat(m[3], 64)
		if err != nil || base <= 0 {
			return nil, ErrNoUnits
		}
		// Divide by the count so the unit describes ONE of the thing. A label
		// reading "2 biscuits (30g)" means each biscuit is 15g; recording 30
		// against the name "biscuit" would double every logged biscuit.
		return []ServingUnit{{Name: singular(m[2]), Amount: 1, BaseAmount: base / count}}, nil
	}
	if m := leadingMass.FindStringSubmatch(servingDesc); m != nil {
		base, err := strconv.ParseFloat(m[1], 64)
		if err != nil || base <= 0 {
			return nil, ErrNoUnits
		}
		return []ServingUnit{{Name: singular(m[3]), Amount: 1, BaseAmount: base}}, nil
	}
	return nil, ErrNoUnits
}

// singular trims a trailing plural "s" so "biscuits" and "biscuit" resolve to
// the same unit name. Deliberately naive: the label vocabulary here is small
// and closed (cup, slice, sachet, biscuit, pack, glass), and an English
// inflection library would be far more machinery than the input warrants.
func singular(name string) string {
	trimmed := strings.TrimSpace(strings.ToLower(name))
	if strings.HasSuffix(trimmed, "s") && len(trimmed) > 2 {
		return strings.TrimSuffix(trimmed, "s")
	}
	return trimmed
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `api/`: `go test ./internal/units/ -run TestParse -v`
Expected: PASS, all 9 subtests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/units/
git commit -m "feat(api): parse serving units from food label text"
```

---

### Task 3: `units` package — curated table and `ToBase`

**Files:**
- Create: `api/internal/units/table.go`
- Create: `api/internal/units/convert.go`
- Test: `api/internal/units/convert_test.go`

**Interfaces:**
- Consumes: `ServingUnit`, `ErrNoUnits` from Task 2
- Produces:
  - `var Table map[string][]ServingUnit` — keyed by lowercase food-name keyword
  - `func Fallback(foodName string) []ServingUnit` — the curated lookup, consulted only on a `Parse` miss
  - `func ToBase(amount float64, unit string, baseUnit string, servingUnits []ServingUnit) (float64, error)`
  - `var ErrNoConversion = errors.New("units: no conversion for unit")`
  - `var ErrInvalidAmount = errors.New("units: amount must be positive")`

- [ ] **Step 1: Write the failing test**

Create `api/internal/units/convert_test.go`:

```go
package units

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToBase(t *testing.T) {
	sachet := []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}}

	tests := []struct {
		name     string
		amount   float64
		unit     string
		baseUnit string
		units    []ServingUnit
		want     float64
	}{
		{name: "base unit passes through", amount: 140, unit: "g", baseUnit: "g", want: 140},
		{name: "millilitre base passes through", amount: 200, unit: "ml", baseUnit: "ml", want: 200},
		{name: "one named serving", amount: 1, unit: "sachet", baseUnit: "g", units: sachet, want: 16.5},
		{name: "two named servings", amount: 2, unit: "sachet", baseUnit: "g", units: sachet, want: 33},
		{name: "unit name is case-insensitive", amount: 1, unit: "Sachet", baseUnit: "g", units: sachet, want: 16.5},
		{name: "kilogram scales to grams", amount: 1.5, unit: "kg", baseUnit: "g", want: 1500},
		{name: "litre scales to millilitres", amount: 1, unit: "L", baseUnit: "ml", want: 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ToBase(tt.amount, tt.unit, tt.baseUnit, tt.units)
			require.NoError(t, err)
			assert.InDelta(t, tt.want, got, 1e-9)
		})
	}
}

func TestToBaseErrors(t *testing.T) {
	sachet := []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}}

	tests := []struct {
		name     string
		amount   float64
		unit     string
		baseUnit string
		units    []ServingUnit
		wantErr  error
	}{
		{name: "unknown unit is an error not a guess", amount: 1, unit: "cup", baseUnit: "g", units: sachet, wantErr: ErrNoConversion},
		{name: "mass unit against a volume base", amount: 1, unit: "kg", baseUnit: "ml", wantErr: ErrNoConversion},
		{name: "zero amount is rejected", amount: 0, unit: "g", baseUnit: "g", wantErr: ErrInvalidAmount},
		{name: "negative amount is rejected", amount: -5, unit: "g", baseUnit: "g", wantErr: ErrInvalidAmount},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ToBase(tt.amount, tt.unit, tt.baseUnit, tt.units)
			assert.ErrorIs(t, err, tt.wantErr)
			assert.Zero(t, got)
		})
	}
}

func TestTableCoversStaples(t *testing.T) {
	// The table is deliberately small. This test pins the promise made in the
	// spec — cups work for the staples and are honestly absent elsewhere —
	// so shrinking it below that is a visible failure, not a silent one.
	for _, key := range []string{"rice", "flour", "milk"} {
		t.Run(key, func(t *testing.T) {
			cups, ok := Table[key]
			require.True(t, ok, "expected a curated entry for %q", key)
			assert.NotEmpty(t, cups)
		})
	}
}

func TestFallback(t *testing.T) {
	tests := []struct {
		name     string
		foodName string
		wantUnit string // "" means no curated entry
	}{
		{name: "keyword matches anywhere in the name", foodName: "White rice, cooked", wantUnit: "cup"},
		{name: "match is case-insensitive", foodName: "Plain FLOUR", wantUnit: "cup"},
		{name: "bread gets a slice, not a cup", foodName: "Wholemeal bread", wantUnit: "slice"},
		{name: "an unlisted food gets nothing", foodName: "Grilled chicken breast", wantUnit: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Fallback(tt.foodName)
			if tt.wantUnit == "" {
				assert.Empty(t, got)
				return
			}
			require.Len(t, got, 1)
			assert.Equal(t, tt.wantUnit, got[0].Name)
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/units/ -run 'TestToBase|TestTable' -v`
Expected: FAIL — `ToBase`, `ErrNoConversion`, `ErrInvalidAmount`, and `Table` are undefined.

- [ ] **Step 3: Write the curated table**

Create `api/internal/units/table.go`:

```go
package units

// Table is the curated fallback consulted only when a food row carries no
// parseable serving unit of its own. It is deliberately small.
//
// Cups need a per-food density that neither OpenFoodFacts nor USDA publishes
// in usable form, so this covers staples where the figure is well established
// and stops there. For most branded products a cup conversion is simply
// absent, and the item falls back to its named serving or raw mass. That is
// the intended trade: an absent conversion is recoverable by the user, a
// fabricated density silently corrupts every total that uses it.
//
// Keyed by a lowercase keyword matched against the food's name. Reviewed like
// code — adding an entry means asserting the figure is real.
var Table = map[string][]ServingUnit{
	"rice":  {{Name: "cup", Amount: 1, BaseAmount: 158}},
	"flour": {{Name: "cup", Amount: 1, BaseAmount: 125}},
	"milk":  {{Name: "cup", Amount: 1, BaseAmount: 250}},
	"oat":   {{Name: "cup", Amount: 1, BaseAmount: 90}},
	"sugar": {{Name: "cup", Amount: 1, BaseAmount: 200}},
	"bread": {{Name: "slice", Amount: 1, BaseAmount: 35}},
}

// Fallback returns the curated serving units for a food name, or nil when the
// food is not in the table. Consulted ONLY after Parse has failed on the row's
// own label text — the row's own serving description is always better evidence
// than a category-level guess.
func Fallback(foodName string) []ServingUnit {
	lowered := strings.ToLower(foodName)
	for keyword, servings := range Table {
		if strings.Contains(lowered, keyword) {
			return servings
		}
	}
	return nil
}
```

`table.go` needs `import "strings"`.

- [ ] **Step 4: Write the conversion implementation**

Create `api/internal/units/convert.go`:

```go
package units

import (
	"errors"
	"strings"
)

// ErrNoConversion reports that no conversion exists from the given unit to
// the food's base unit. Callers must surface this — never substitute a
// default — and fall back to raw base-unit entry.
var ErrNoConversion = errors.New("units: no conversion for unit")

// ErrInvalidAmount reports a non-positive amount.
var ErrInvalidAmount = errors.New("units: amount must be positive")

// Scale factors from a bulk unit to its base. Mass and volume are kept
// separate on purpose: converting kg against an ml base would require a
// density this package refuses to invent.
var massScale = map[string]float64{"g": 1, "kg": 1000}
var volumeScale = map[string]float64{"ml": 1, "l": 1000}

// ToBase converts amount of unit into the food's base unit. It is the single
// conversion entry point in the system, and it returns an error rather than
// guessing when no conversion exists.
func ToBase(amount float64, unit string, baseUnit string, servingUnits []ServingUnit) (float64, error) {
	if amount <= 0 {
		return 0, ErrInvalidAmount
	}
	normalized := strings.ToLower(strings.TrimSpace(unit))

	// A bulk mass/volume unit, valid only against a matching base.
	switch strings.ToLower(baseUnit) {
	case "g":
		if scale, ok := massScale[normalized]; ok {
			return amount * scale, nil
		}
	case "ml":
		if scale, ok := volumeScale[normalized]; ok {
			return amount * scale, nil
		}
	}

	// A named serving carried by the food row itself.
	for _, su := range servingUnits {
		if strings.ToLower(su.Name) == normalized && su.Amount > 0 {
			return amount * (su.BaseAmount / su.Amount), nil
		}
	}

	return 0, ErrNoConversion
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/units/ -v`
Expected: PASS, all subtests across `TestParse`, `TestParseNoUnits`, `TestToBase`, `TestToBaseErrors`, `TestTableCoversStaples`.

- [ ] **Step 6: Commit**

```bash
git add api/internal/units/
git commit -m "feat(api): add unit conversion with a curated fallback table"
```

---

### Task 4: OpenFoodFacts ingest reads the serving unit

**Files:**
- Modify: `api/internal/nutrition/barcode.go:40-82`
- Test: `api/internal/nutrition/barcode_test.go`

**Interfaces:**
- Consumes: `units.Parse`, `units.ServingUnit` from Task 2; `FoodItem.BaseUnit`, `FoodItem.ServingUnits` from Task 1
- Produces: OFF-sourced `FoodItem` rows carrying a correct `BaseUnit` and populated `ServingUnits`

- [ ] **Step 1: Write the failing test**

Add to `api/internal/nutrition/barcode_test.go` (follow the existing httptest server pattern in that file for constructing the OFF stub):

```go
func TestFetchByBarcodeSetsBaseUnitFromServingUnit(t *testing.T) {
	tests := []struct {
		name         string
		servingUnit  string
		servingSize  string
		wantBaseUnit string
		wantServing  string // the serving unit name expected in ServingUnits, "" for none
	}{
		{
			name:         "millilitre serving marks the row as a liquid",
			servingUnit:  "ml",
			servingSize:  "1 glass (250ml)",
			wantBaseUnit: "ml",
			wantServing:  "glass",
		},
		{
			name:         "gram serving stays a mass row",
			servingUnit:  "g",
			servingSize:  "1 sachet (16.5g)",
			wantBaseUnit: "g",
			wantServing:  "sachet",
		},
		{
			name:         "absent unit defaults to grams",
			servingUnit:  "",
			servingSize:  "",
			wantBaseUnit: "g",
			wantServing:  "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Serve an OFF payload carrying serving_quantity_unit and
			// serving_size, using the same stub-server shape as the existing
			// tests in this file.
			srv := offStubServer(t, offProduct{
				ProductName:         "Test product",
				EnergyKcal100g:      100,
				ServingQuantity:     250,
				ServingQuantityUnit: tt.servingUnit,
				ServingSize:         tt.servingSize,
			})
			defer srv.Close()

			item, err := NewOFFClient(srv.URL).FetchByBarcode(context.Background(), "9310232956596")
			require.NoError(t, err)
			require.NotNil(t, item)

			assert.Equal(t, tt.wantBaseUnit, item.BaseUnit)
			if tt.wantServing == "" {
				assert.Empty(t, string(item.ServingUnits))
				return
			}
			var got []units.ServingUnit
			require.NoError(t, json.Unmarshal(item.ServingUnits, &got))
			require.Len(t, got, 1)
			assert.Equal(t, tt.wantServing, got[0].Name)
		})
	}
}
```

If `offStubServer`/`offProduct` helpers do not already exist in that test file, write them to match the existing tests' inline `httptest.NewServer` usage — do not restructure the existing tests.

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/nutrition/ -run TestFetchByBarcodeSetsBaseUnit -v`
Expected: FAIL — `BaseUnit` is empty because nothing sets it.

- [ ] **Step 3: Implement the ingest change**

In `api/internal/nutrition/barcode.go`, add `ServingQuantityUnit string \`json:"serving_quantity_unit"\`` and `ServingSize string \`json:"serving_size"\`` to the anonymous `Product` struct alongside the existing `ServingQuantity`.

Then replace the `return &FoodItem{...}` construction so it sets the two new fields:

```go
	code := barcode
	item := &FoodItem{
		Name:           body.Product.ProductName,
		Brand:          body.Product.Brands,
		Provenance:     ProvenanceOFF,
		Barcode:        &code,
		ServingDesc:    body.Product.ServingSize,
		ServingGrams:   body.Product.ServingQuantity,
		BaseUnit:       baseUnitFor(body.Product.ServingQuantityUnit),
		KcalPer100g:    body.Product.Nutriments.EnergyKcal100g,
		ProteinPer100g: body.Product.Nutriments.Protein100g,
		CarbsPer100g:   body.Product.Nutriments.Carbs100g,
		FatPer100g:     body.Product.Nutriments.Fat100g,
		FiberPer100g:   body.Product.Nutriments.Fiber100g,
	}
	// A parse miss is not a failure — the product simply has no named serving
	// and the client falls back to raw base-unit entry. Logged so the curated
	// table can be grown from real observed text rather than guesswork.
	if parsed, err := units.Parse(body.Product.ServingSize); err == nil {
		if encoded, mErr := json.Marshal(parsed); mErr == nil {
			item.ServingUnits = encoded
		}
	} else {
		slog.DebugContext(ctx, "nutrition: no serving unit parsed from OFF label",
			"barcode", barcode, "serving_size", body.Product.ServingSize)
	}
	return item, nil
```

Add this helper to the same file:

```go
// baseUnitFor maps OpenFoodFacts' serving_quantity_unit onto our two-value
// base unit. OFF reports a liquid's nutriments per 100 ml already, so this is
// purely a labelling decision — no numeric conversion is implied. Anything
// unrecognised falls back to grams, which is what every pre-000026 row is.
func baseUnitFor(offUnit string) string {
	switch strings.ToLower(strings.TrimSpace(offUnit)) {
	case "ml", "l":
		return "ml"
	default:
		return "g"
	}
}
```

Add `encoding/json`, `log/slog`, `strings`, and `github.com/tesserix/kora/api/internal/units` to the file's imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/nutrition/ -v`
Expected: PASS, including the pre-existing barcode tests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition/barcode.go api/internal/nutrition/barcode_test.go
git commit -m "feat(api): read the serving unit and named servings from OpenFoodFacts"
```

---

### Task 5: Backfill command for existing rows

**Files:**
- Create: `api/cmd/backfillunits/main.go`
- Test: `api/cmd/backfillunits/main_test.go`

**Interfaces:**
- Consumes: `units.Parse` from Task 2; `nutrition.FoodItem` from Task 1
- Produces: `func backfillItem(item nutrition.FoodItem) (json.RawMessage, bool)` — the pure, testable core

Migration SQL cannot call `units.Parse`, so the `serving_units` backfill for the ~7,900 seeded rows runs as a Go command, mirroring the existing `cmd/seed` job already deployed as `kora-api-seed`.

- [ ] **Step 1: Write the failing test**

Create `api/cmd/backfillunits/main_test.go`:

```go
package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

func TestBackfillItem(t *testing.T) {
	tests := []struct {
		name       string
		item       nutrition.FoodItem
		wantOK     bool
		wantName   string
		wantAmount float64
	}{
		{
			name:       "seeded cup serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 cup (158g)"},
			wantOK:     true,
			wantName:   "cup",
			wantAmount: 158,
		},
		{
			name:       "seeded sachet serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 sachet (16.5g)"},
			wantOK:     true,
			wantName:   "sachet",
			wantAmount: 16.5,
		},
		{
			name:       "unparseable description falls back to the curated table",
			item:       nutrition.FoodItem{Name: "White rice, cooked", ServingDesc: "per serving"},
			wantOK:     true,
			wantName:   "cup",
			wantAmount: 158,
		},
		{
			name:   "unparseable description with no curated entry is skipped",
			item:   nutrition.FoodItem{Name: "Grilled chicken breast", ServingDesc: "per serving"},
			wantOK: false,
		},
		{
			name:   "a row that already has units is left alone",
			item:   nutrition.FoodItem{ServingDesc: "1 cup (158g)", ServingUnits: json.RawMessage(`[{"name":"bowl","amount":1,"base_amount":300}]`)},
			wantOK: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := backfillItem(tt.item)
			assert.Equal(t, tt.wantOK, ok)
			if !tt.wantOK {
				return
			}
			var parsed []units.ServingUnit
			require.NoError(t, json.Unmarshal(got, &parsed))
			require.Len(t, parsed, 1)
			assert.Equal(t, tt.wantName, parsed[0].Name)
			assert.InDelta(t, tt.wantAmount, parsed[0].BaseAmount, 1e-9)
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./cmd/backfillunits/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write the implementation**

Create `api/cmd/backfillunits/main.go`. Model the database wiring on `api/cmd/seed/main.go` — read the same config, open the same GORM connection, log with `slog`:

```go
// Command backfillunits populates food_items.serving_units for rows written
// before migration 000026, by parsing the serving_desc text they already
// carry. Idempotent: a row that already has units is skipped, so re-running
// the job is safe and never overwrites a curated or OFF-sourced value.
package main

func backfillItem(item nutrition.FoodItem) (json.RawMessage, bool) {
	// Never clobber units a row already has — those came from OFF or an admin
	// and are better evidence than a re-parse of the description text.
	if len(item.ServingUnits) > 0 && string(item.ServingUnits) != "[]" && string(item.ServingUnits) != "null" {
		return nil, false
	}
	// The row's own label first — it is always better evidence than a
	// category-level guess. Only when it yields nothing do we fall back to the
	// curated table, and when that is empty too the food simply has no named
	// serving and the client uses raw base-unit entry.
	parsed, err := units.Parse(item.ServingDesc)
	if err != nil {
		parsed = units.Fallback(item.Name)
		if len(parsed) == 0 {
			return nil, false
		}
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil, false
	}
	return encoded, true
}
```

The `main` function loads config, opens the DB, selects all `food_items` in batches of 500, calls `backfillItem` on each, and issues an `UPDATE food_items SET serving_units = ? WHERE id = ?` for each row where the bool is true. Log a final count of rows updated and rows skipped.

- [ ] **Step 4: Run the test to verify it passes**

Run from `api/`: `go test ./cmd/backfillunits/ -v && go build ./...`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add api/cmd/backfillunits/
git commit -m "feat(api): add a backfill command for serving units on existing food rows"
```

---

### Task 6: Persist the entered unit on food logs

**Files:**
- Modify: `api/internal/foodlog/service.go:34-50` (CreateRequest), `:100-150` (Create), `:186-240` (UpdateRequest and Update)
- Modify: `api/internal/foodlog/repository.go:185-200`
- Test: `api/internal/foodlog/service_test.go`

**Interfaces:**
- Consumes: `units.ToBase`, `units.ErrNoConversion`, `units.ErrInvalidAmount` from Task 3; `FoodLog.EnteredAmount`/`EnteredUnit` from Task 1
- Produces: `CreateRequest.EnteredAmount *float64`, `CreateRequest.EnteredUnit *string`; logs whose `quantity_grams` is derived server-side from the entered pair

- [ ] **Step 1: Write the failing test**

Add to `api/internal/foodlog/service_test.go`, following the existing service-test setup in that file:

```go
func TestCreateResolvesEnteredUnitToGrams(t *testing.T) {
	// The sachet food row: one sachet is 16.5g, base unit grams.
	item := nutrition.FoodItem{
		ID:           uuid.New(),
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}

	amount := 2.0
	unit := "sachet"
	got, err := svc.Create(ctx, userID, CreateRequest{
		FoodItemID:    item.ID,
		EnteredAmount: &amount,
		EnteredUnit:   &unit,
		MealSlot:      "snack",
	})
	require.NoError(t, err)

	// Two sachets = 33g, resolved server-side. The entered pair is stored
	// verbatim beside it so the diary can read back "2 sachet".
	assert.InDelta(t, 33.0, got.QuantityGrams, 1e-9)
	require.NotNil(t, got.EnteredAmount)
	assert.InDelta(t, 2.0, *got.EnteredAmount, 1e-9)
	require.NotNil(t, got.EnteredUnit)
	assert.Equal(t, "sachet", *got.EnteredUnit)
}

func TestCreateRejectsUnknownUnit(t *testing.T) {
	item := nutrition.FoodItem{ID: uuid.New(), BaseUnit: "g", KcalPer100g: 100}
	amount := 1.0
	unit := "cup"

	_, err := svc.Create(ctx, userID, CreateRequest{
		FoodItemID:    item.ID,
		EnteredAmount: &amount,
		EnteredUnit:   &unit,
		MealSlot:      "snack",
	})
	// An unknown unit must surface as validation, never as a silent default.
	var verr httpx.ValidationError
	require.ErrorAs(t, err, &verr)
	assert.Contains(t, verr.Message, "unit")
}

func TestCreateWithoutEnteredUnitIsUnchanged(t *testing.T) {
	// The legacy path: grams straight through, entered pair left null.
	got, err := svc.Create(ctx, userID, CreateRequest{
		FoodItemID:    knownItemID,
		QuantityGrams: 140,
		MealSlot:      "lunch",
	})
	require.NoError(t, err)
	assert.InDelta(t, 140.0, got.QuantityGrams, 1e-9)
	assert.Nil(t, got.EnteredAmount)
	assert.Nil(t, got.EnteredUnit)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/foodlog/ -run TestCreate -v`
Expected: FAIL — `CreateRequest` has no `EnteredAmount`/`EnteredUnit`.

- [ ] **Step 3: Implement the service change**

Add to `CreateRequest` in `api/internal/foodlog/service.go`:

```go
	EnteredAmount *float64 `json:"entered_amount"`
	EnteredUnit   *string  `json:"entered_unit"`
```

In `Create`, before the existing `if req.QuantityGrams <= 0` validation, resolve the entered pair into grams:

```go
	// When the caller entered a unit, the SERVER derives quantity_grams from
	// it — the client never converts. Resolution happens exactly once, here,
	// and the result is what every nutrition figure is computed from
	// thereafter. A later correction to a serving mass therefore changes
	// future logs only, and never rewrites what a past day's totals said.
	if req.EnteredAmount != nil && req.EnteredUnit != nil {
		grams, err := units.ToBase(*req.EnteredAmount, *req.EnteredUnit, item.BaseUnit, servingUnits)
		if err != nil {
			return FoodLog{}, httpx.ValidationError{Message: "unrecognised unit for this food"}
		}
		req.QuantityGrams = grams
	}
```

where `servingUnits` is decoded from `item.ServingUnits` with `json.Unmarshal` (treat a decode error as an empty slice — a malformed stored value must not break logging, it just means no named servings resolve).

Set the two fields on the constructed `FoodLog` alongside `QuantityGrams`, and add both columns to the update map in `repository.go:192`.

Apply the same treatment to `UpdateRequest`/`Update`: when the entered pair is supplied, re-resolve grams from it; when only `QuantityGrams` is supplied, null both entered fields, because the stored pair no longer describes the amount.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/foodlog/ -v`
Expected: PASS, including all pre-existing food-log tests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog/
git commit -m "feat(api): resolve and store the entered unit on food logs"
```

---

### Task 7: Persist the entered unit on saved meal items

**Files:**
- Modify: `api/internal/savedmeals/model.go:19-27`, `api/internal/savedmeals/service.go`, `api/internal/savedmeals/repository.go`
- Test: `api/internal/savedmeals/service_test.go`

**Interfaces:**
- Consumes: everything from Task 6
- Produces: `SavedMealItem.EnteredAmount *float64`, `SavedMealItem.EnteredUnit *string`, and the same fields on the item payload of the create/update request

- [ ] **Step 1: Write the failing test**

Add to `api/internal/savedmeals/service_test.go`:

```go
func TestCreateSavedMealResolvesEnteredUnits(t *testing.T) {
	amount := 1.0
	unit := "sachet"

	got, err := svc.Create(ctx, userID, CreateRequest{
		Name:     "Morning mocha",
		MealSlot: "breakfast",
		Items: []ItemInput{
			{FoodItemID: sachetItemID, EnteredAmount: &amount, EnteredUnit: &unit},
			{FoodItemID: milkItemID, Grams: 200},
		},
	})
	require.NoError(t, err)
	require.Len(t, got.Items, 2)

	// The sachet resolved server-side; the gram-entered milk is untouched.
	assert.InDelta(t, 16.5, got.Items[0].Grams, 1e-9)
	require.NotNil(t, got.Items[0].EnteredUnit)
	assert.Equal(t, "sachet", *got.Items[0].EnteredUnit)

	assert.InDelta(t, 200.0, got.Items[1].Grams, 1e-9)
	assert.Nil(t, got.Items[1].EnteredUnit)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/savedmeals/ -run TestCreateSavedMeal -v`
Expected: FAIL — `ItemInput` has no `EnteredAmount`/`EnteredUnit`.

- [ ] **Step 3: Implement**

Add `EnteredAmount *float64` and `EnteredUnit *string` to `SavedMealItem` (with `gorm:"column:entered_amount"` / `gorm:"column:entered_unit"`) and to the request's item input type. In the create/update service path, resolve each item's entered pair through `units.ToBase` exactly as Task 6 does for logs, writing the result into `Grams`. Reuse the same validation message so both surfaces read identically. Include the columns in the `ItemRow` joined read so `List` returns them.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/savedmeals/ -v && go test ./... 2>&1 | tail -20`
Expected: PASS across the whole API suite.

- [ ] **Step 5: Commit**

```bash
git add api/internal/savedmeals/
git commit -m "feat(api): resolve and store the entered unit on saved meal items"
```

---

### Task 8: Client portion formatting

**Files:**
- Create: `apps/mobile/src/units/portion.ts`
- Modify: `apps/mobile/src/api/types.ts`
- Test: `apps/mobile/src/units/__tests__/portion.test.ts`

**Interfaces:**
- Consumes: the API fields from Tasks 1, 6, 7
- Produces:
  - `type ServingUnit = { name: string; amount: number; base_amount: number }`
  - `type PortionEntry = { quantity_grams: number; entered_amount?: number | null; entered_unit?: string | null; base_unit?: string | null }`
  - `function formatPortion(entry: PortionEntry): string`

**Do not modify `apps/mobile/src/units/convert.ts`.** It owns body weight and water, and the metric/imperial preference must not reach food portions.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/units/__tests__/portion.test.ts`:

```typescript
import { formatPortion } from "../portion";

describe("formatPortion", () => {
  it("shows a named serving as entered", () => {
    expect(formatPortion({ quantity_grams: 16.5, entered_amount: 1, entered_unit: "sachet" })).toBe("1 sachet");
  });

  it("pluralises a named serving above one", () => {
    expect(formatPortion({ quantity_grams: 33, entered_amount: 2, entered_unit: "sachet" })).toBe("2 sachets");
  });

  it("keeps a fractional amount readable", () => {
    expect(formatPortion({ quantity_grams: 79, entered_amount: 0.5, entered_unit: "cup" })).toBe("0.5 cup");
  });

  it("shows a volume in ml for a liquid row", () => {
    expect(formatPortion({ quantity_grams: 200, entered_amount: 200, entered_unit: "ml", base_unit: "ml" })).toBe("200 ml");
  });

  it("shows grams for a mass row entered in grams", () => {
    expect(formatPortion({ quantity_grams: 140, entered_amount: 140, entered_unit: "g" })).toBe("140 g");
  });

  it("falls back to grams for a legacy log with no entered unit", () => {
    expect(formatPortion({ quantity_grams: 140 })).toBe("140 g");
  });

  it("falls back to the base unit for a legacy liquid log", () => {
    expect(formatPortion({ quantity_grams: 200, base_unit: "ml" })).toBe("200 ml");
  });

  it("rounds a legacy gram figure for display", () => {
    expect(formatPortion({ quantity_grams: 16.5 })).toBe("17 g");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/units/__tests__/portion.test.ts`
Expected: FAIL — cannot resolve `../portion`.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/src/units/portion.ts`:

```typescript
/**
 * Food portion formatting. Deliberately separate from ./convert.ts, which owns
 * body weight and water and is driven by the user's metric/imperial
 * preference — food portions are always metric and must not read that setting.
 *
 * This module formats only. It never converts between units and never derives
 * nutrition: the server resolved the entered amount into quantity_grams once,
 * at write time, and that figure is authoritative.
 */

export type ServingUnit = {
  name: string;
  amount: number;
  base_amount: number;
};

export type PortionEntry = {
  quantity_grams: number;
  entered_amount?: number | null;
  entered_unit?: string | null;
  base_unit?: string | null;
};

// Bulk units render with a space and no pluralisation ("200 ml", "140 g");
// named servings pluralise ("2 sachets").
const BULK_UNITS = new Set(["g", "kg", "ml", "l"]);

function formatAmount(amount: number): string {
  // Whole numbers read as whole; fractions keep one decimal so "0.5 cup"
  // survives, but "1.0 cup" never appears.
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 10) / 10);
}

export function formatPortion(entry: PortionEntry): string {
  const { entered_amount, entered_unit } = entry;

  // A legacy row carries no entered pair. Show the canonical figure in the
  // food's own base unit — that is all the information there is.
  if (entered_amount == null || !entered_unit) {
    const unit = entry.base_unit === "ml" ? "ml" : "g";
    return `${Math.round(entry.quantity_grams)} ${unit}`;
  }

  const unit = entered_unit.toLowerCase();
  if (BULK_UNITS.has(unit)) {
    return `${formatAmount(entered_amount)} ${unit}`;
  }
  const plural = entered_amount === 1 ? entered_unit : `${entered_unit}s`;
  return `${formatAmount(entered_amount)} ${plural}`;
}
```

Add the matching optional fields to the `FoodItem` and `FoodLog` types in `apps/mobile/src/api/types.ts`: `base_unit?: string`, `serving_units?: ServingUnit[]` on the item, and `entered_amount?: number | null`, `entered_unit?: string | null` on the log.

- [ ] **Step 4: Run the test to verify it passes**

Run from `apps/mobile/`: `npx jest src/units/__tests__/portion.test.ts && npx tsc --noEmit`
Expected: PASS, 8 tests. Clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/units/portion.ts apps/mobile/src/units/__tests__/portion.test.ts apps/mobile/src/api/types.ts
git commit -m "feat(mobile): add unit-aware portion formatting"
```

---

### Task 9: Route every read-only portion display through `formatPortion`

**Files:**
- Modify: `apps/mobile/src/components/capture/DetectedCard.tsx:131-136`
- Modify: `apps/mobile/src/components/meal/AskAgainSheet.tsx:57-59`
- Modify: `apps/mobile/src/components/home/PinnedStrip.tsx:32`
- Modify: `apps/mobile/src/components/home/YourUsualStrip.tsx:57`
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (the portion string on each log row)
- Test: `apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx`

**Interfaces:**
- Consumes: `formatPortion` from Task 8
- Produces: no new exports — this task removes inlined `${Math.round(x)}g` strings

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx`:

```typescript
test("a liquid candidate renders its portion in ml, not grams", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: base.candidates.map((c) => ({
      ...c,
      portion_grams: 200,
      item: { ...c.item, base_unit: "ml" },
    })),
  };

  const { queryByText } = await renderCard(resolution);

  expect(queryByText("200 ml")).toBeTruthy();
  expect(queryByText("200g")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/capture/__tests__/DetectedCard.test.tsx -t "liquid candidate"`
Expected: FAIL — the row renders `200g`.

- [ ] **Step 3: Replace the inlined strings**

In `DetectedCard.tsx`, replace both branches of the caption with `formatPortion`:

```typescript
        <AppText style={{ color: captureColors.onSurfaceFaint, fontSize: 11 }}>
          {uncertain
            ? `${formatPortion({ quantity_grams: candidate.portion_grams, base_unit: candidate.item.base_unit })} · Best guess — tap to change`
            : formatPortion({ quantity_grams: candidate.portion_grams, base_unit: candidate.item.base_unit })}
        </AppText>
```

Apply the equivalent substitution at each of the other four sites, passing the log's or candidate's own `entered_amount`/`entered_unit`/`base_unit` where available. Do not change any surrounding copy — the `· Best guess — tap to change` suffix from commit `d701c8f` stays exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `apps/mobile/`: `npx jest src/components/capture src/components/home app/__tests__ && npx tsc --noEmit`
Expected: PASS, no regressions in the preselection tests from `d701c8f`.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components apps/mobile/app/\(tabs\)/diary.tsx
git commit -m "feat(mobile): render every portion through the shared unit-aware formatter"
```

---

### Task 10: `PortionField` — serving-first entry

**Files:**
- Create: `apps/mobile/src/components/units/PortionField.tsx`
- Test: `apps/mobile/src/components/units/__tests__/PortionField.test.tsx`

**Interfaces:**
- Consumes: `ServingUnit`, `formatPortion` from Task 8
- Produces:

```typescript
interface PortionFieldProps {
  baseUnit: "g" | "ml";
  servingUnits: ServingUnit[];
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
}
export function PortionField(props: PortionFieldProps): ReactElement
```

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/units/__tests__/PortionField.test.tsx`:

```typescript
import { fireEvent } from "@testing-library/react-native";
import { PortionField } from "../PortionField";
import { render } from "@/test/render";

const SACHET = [{ name: "sachet", amount: 1, base_amount: 16.5 }];

test("defaults to a stepper on the food's own serving", async () => {
  const { getByText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={() => {}} />,
  );
  expect(getByText("1 sachet (16.5 g)")).toBeTruthy();
});

test("incrementing reports the new amount in the same unit", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  fireEvent.press(getByLabelText("Increase amount"));
  expect(onChange).toHaveBeenCalledWith(2, "sachet");
});

test("decrementing below one serving does not go to zero", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  fireEvent.press(getByLabelText("Decrease amount"));
  expect(onChange).not.toHaveBeenCalled();
});

test("the escape hatch switches to exact amount entry in the base unit", async () => {
  const onChange = jest.fn();
  const { getByText, getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  fireEvent.press(getByText("Enter exact amount"));
  fireEvent.changeText(getByLabelText("Amount"), "45");
  expect(onChange).toHaveBeenCalledWith(45, "g");
});

test("a food with no named serving opens directly in exact-amount mode", async () => {
  const { getByLabelText, queryByText } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={() => {}} />,
  );
  expect(getByLabelText("Amount")).toBeTruthy();
  expect(queryByText("Enter exact amount")).toBeNull();
});

test("a non-positive amount is not reported", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={onChange} />,
  );
  fireEvent.changeText(getByLabelText("Amount"), "0");
  expect(onChange).not.toHaveBeenCalled();
});
```

If `@/test/render` does not exist, use whatever render helper the neighbouring component tests already use (check `apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx`) — do not introduce a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/units/__tests__/PortionField.test.tsx`
Expected: FAIL — cannot resolve `../PortionField`.

- [ ] **Step 3: Write the component**

Create `apps/mobile/src/components/units/PortionField.tsx`. Requirements it must satisfy:

- When `servingUnits` is non-empty and `unit` is one of them, render a stepper reading `` `${amount} ${unit}${amount === 1 ? "" : "s"} (${baseTotal} ${baseUnit})` `` with `−` and `+` `Pressable`s labelled `Decrease amount` / `Increase amount`, plus an `Enter exact amount` text button.
- `+` calls `onChange(amount + 1, unit)`. `−` calls `onChange(amount - 1, unit)` only when `amount > 1`; at 1 it does nothing, because zero servings is not a portion.
- `Enter exact amount` switches to exact mode: a `TextInput` labelled `Amount` with `keyboardType="decimal-pad"` and a unit dropdown seeded with the base unit plus every named serving.
- Exact mode reports `onChange(parsed, selectedUnit)` on every valid change, and reports nothing when the parsed value is not finite or is `<= 0`.
- When `servingUnits` is empty, the component starts in exact mode and does not render the escape-hatch link.
- Use the existing theme tokens via `useTheme()` and match the input styling already used in `apps/mobile/src/components/meals/SavedMealSheet.tsx:91-97`.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `apps/mobile/`: `npx jest src/components/units/ && npx tsc --noEmit`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/units/
git commit -m "feat(mobile): add a serving-first portion entry field"
```

---

### Task 11: Wire `PortionField` into the entry surfaces

**Files:**
- Modify: `apps/mobile/app/meal.tsx:87-140`
- Modify: `apps/mobile/src/components/meals/SavedMealSheet.tsx:20-100`
- Modify: `apps/mobile/app/log.tsx:99-110`
- Test: `apps/mobile/app/__tests__/meal.test.tsx`, `apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx`

**Interfaces:**
- Consumes: `PortionField` from Task 10; the API fields from Tasks 6 and 7
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/app/__tests__/meal.test.tsx`:

```typescript
test("editing a sachet log sends the entered unit, not grams", async () => {
  const { getByLabelText } = await renderMeal({
    quantity_grams: 16.5,
    entered_amount: 1,
    entered_unit: "sachet",
    item: { base_unit: "g", serving_units: [{ name: "sachet", amount: 1, base_amount: 16.5 }] },
  });

  fireEvent.press(getByLabelText("Increase amount"));
  fireEvent.press(getByLabelText("Save"));

  // The client sends what the user entered; the SERVER derives the grams.
  expect(updateLog).toHaveBeenCalledWith(
    expect.objectContaining({ entered_amount: 2, entered_unit: "sachet" }),
  );
  expect(updateLog).not.toHaveBeenCalledWith(expect.objectContaining({ quantity_grams: 33 }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest app/__tests__/meal.test.tsx -t "sachet log"`
Expected: FAIL — the screen renders a raw grams input and sends `quantity_grams`.

- [ ] **Step 3: Replace the raw grams inputs**

In `app/meal.tsx`, replace the grams `TextInput` with `PortionField`, seeded from the fetched log's `entered_amount`/`entered_unit` (falling back to `quantity_grams` + the item's base unit for a legacy log). Send `entered_amount`/`entered_unit` in the update payload instead of `quantity_grams` whenever the user is in serving mode; keep sending `quantity_grams` when they used exact mode in the base unit.

Do the same in `SavedMealSheet.tsx` — its `EditItem` type gains `amount: number` and `unit: string` alongside the existing fields, and the per-item grams `TextInput` becomes a `PortionField`.

In `app/log.tsx`, replace the grams field on the confirm step with `PortionField` seeded from `selected.serving_units` and `selected.base_unit`.

The macro preview in `meal.tsx:101` (`scale`) must keep scaling from `quantity_grams` — it is a display-only preview of the server's own figures and must not start computing from the entered unit.

- [ ] **Step 4: Run the full mobile suite**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS across all suites, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/meal.tsx apps/mobile/app/log.tsx apps/mobile/src/components/meals/SavedMealSheet.tsx apps/mobile/app/__tests__ apps/mobile/src/components/meals/__tests__
git commit -m "feat(mobile): use serving-first portion entry on the meal, log and saved meal screens"
```

---

## Verification

After Task 11, run the full suite from the repo root:

```bash
cd api && go build ./... && go vet ./... && go test ./...
cd ../apps/mobile && npx jest && npx tsc --noEmit
```

Then verify the two motivating cases by hand on the **iPhone 17 Pro** simulator (not the Pro Max):

1. Scan barcode `9300605158641` (NESCAFÉ Mocha). Expect the capture card to read **1 sachet** and roughly 90 kcal.
2. Scan barcode `9310232956596` (HIGH PROTEIN LOW FAT MILK). Expect the portion to read in **ml**, not g.
3. Open an existing pre-migration log in the diary. Expect it to still read in grams and be editable without error.
