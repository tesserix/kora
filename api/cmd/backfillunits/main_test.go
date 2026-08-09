package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

func TestBackfillItem(t *testing.T) {
	tests := []struct {
		name       string
		item       nutrition.FoodItem
		wantOK     bool
		wantSource string
		wantName   string
		wantAmount float64
	}{
		{
			name:       "seeded cup serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 cup (158g)"},
			wantOK:     true,
			wantSource: sourceParse,
			wantName:   "cup",
			wantAmount: 158,
		},
		{
			name:       "seeded sachet serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 sachet (16.5g)"},
			wantOK:     true,
			wantSource: sourceParse,
			wantName:   "sachet",
			wantAmount: 16.5,
		},
		{
			name:       "unparseable description falls back to the curated table",
			item:       nutrition.FoodItem{Name: "White rice, cooked", ServingDesc: "per serving"},
			wantOK:     true,
			wantSource: sourceFallback,
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
			assert.Equal(t, tt.wantSource, got.Source)
			var parsed []units.ServingUnit
			require.NoError(t, json.Unmarshal(got.Encoded, &parsed))
			require.Len(t, parsed, 1)
			assert.Equal(t, tt.wantName, parsed[0].Name)
			assert.InDelta(t, tt.wantAmount, parsed[0].BaseAmount, 1e-9)
		})
	}
}

// TestBackfillItemDoesNotContradictOwnLabel pins the seeded row that motivated
// the word-boundary rule: "Rolled oats, dry" says 40 g on its own label, and a
// substring match on "oat" would have written cup = 90 g against it.
func TestBackfillItemDoesNotContradictOwnLabel(t *testing.T) {
	_, ok := backfillItem(nutrition.FoodItem{Name: "Rolled oats, dry", ServingDesc: "1/2 cup (40g)"})
	assert.False(t, ok, "a row whose own label cannot be parsed must not inherit a contradicting density")
}

func TestNeedsBaseUnitRefetch(t *testing.T) {
	code := "9310232956596"
	blank := ""
	assert.True(t, needsBaseUnitRefetch(nutrition.FoodItem{Provenance: nutrition.ProvenanceOFF, Barcode: &code}))
	assert.False(t, needsBaseUnitRefetch(nutrition.FoodItem{Provenance: nutrition.ProvenanceAFCD, Barcode: &code}))
	assert.False(t, needsBaseUnitRefetch(nutrition.FoodItem{Provenance: nutrition.ProvenanceOFF}))
	assert.False(t, needsBaseUnitRefetch(nutrition.FoodItem{Provenance: nutrition.ProvenanceOFF, Barcode: &blank}))
}

func TestBaseUnitPlan(t *testing.T) {
	t.Run("a millilitre product corrects a gram row", func(t *testing.T) {
		got, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "g"}, &nutrition.FoodItem{BaseUnit: "ml"})
		assert.True(t, ok)
		assert.Equal(t, "ml", got)
	})
	t.Run("an already-correct row is not rewritten", func(t *testing.T) {
		_, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "ml"}, &nutrition.FoodItem{BaseUnit: "ml"})
		assert.False(t, ok)
	})
	t.Run("an absent fetch writes nothing", func(t *testing.T) {
		_, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "g"}, nil)
		assert.False(t, ok)
	})
}

// fakeOFF is an OFFClient double: it answers from a barcode map and can be
// made to fail, so the job's skip-and-continue behaviour is testable.
type fakeOFF struct {
	byCode map[string]*nutrition.FoodItem
	fail   map[string]bool
	calls  []string
}

func (f *fakeOFF) Fetch(ctx context.Context, barcode string) (*nutrition.FoodItem, error) {
	f.calls = append(f.calls, barcode)
	if f.fail[barcode] {
		return nil, errors.New("off unreachable")
	}
	return f.byCode[barcode], nil
}

var _ nutrition.OFFClient = (*fakeOFF)(nil)

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

// seedItem inserts one food row and cleans it up afterwards.
func seedItem(t *testing.T, db *gorm.DB, item nutrition.FoodItem) nutrition.FoodItem {
	t.Helper()
	item.Name = item.Name + " " + uuid.NewString()
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func reload(t *testing.T, db *gorm.DB, id uuid.UUID) nutrition.FoodItem {
	t.Helper()
	var got nutrition.FoodItem
	require.NoError(t, db.First(&got, "id = ?", id).Error)
	return got
}

// TestRunCorrectsBaseUnitForOFFRows is the regression pin for the milk bug:
// before this, run() only ever wrote serving_units, so an OFF drink cached as
// base_unit 'g' stayed grams forever — ResolveBarcode short-circuits on a
// local hit, so re-scanning never refreshed it either.
func TestRunCorrectsBaseUnitForOFFRows(t *testing.T) {
	db := testDB(t)
	code := "milk-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "HIGH PROTEIN LOW FAT MILK", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "g", ServingDesc: "1 portion (300 ml)", KcalPer100g: 52,
	})

	off := &fakeOFF{byCode: map[string]*nutrition.FoodItem{code: {BaseUnit: "ml"}}}
	_, err := run(context.Background(), db.Where("id = ?", item.ID), options{OFF: off})
	require.NoError(t, err)

	assert.Equal(t, "ml", reload(t, db, item.ID).BaseUnit)
}

// TestRunSkipsRowsWhoseBaseUnitIsAlreadyRight keeps the job idempotent: a
// second pass must not rewrite rows it already fixed.
func TestRunSkipsRowsWhoseBaseUnitIsAlreadyRight(t *testing.T) {
	db := testDB(t)
	code := "ml-ok-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Already correct drink", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "ml", ServingDesc: "per serving", KcalPer100g: 30,
	})

	off := &fakeOFF{byCode: map[string]*nutrition.FoodItem{code: {BaseUnit: "ml"}}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 0, s.BaseUnitWritten)
	assert.Equal(t, "ml", reload(t, db, item.ID).BaseUnit)
}

// TestRunSurvivesAnOFFFetchFailure proves one unreachable product neither
// fails the job nor corrupts the row.
func TestRunSurvivesAnOFFFetchFailure(t *testing.T) {
	db := testDB(t)
	code := "boom-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Unreachable product", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "g", ServingDesc: "per serving", KcalPer100g: 30,
	})

	off := &fakeOFF{fail: map[string]bool{code: true}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitFailed)
	assert.Equal(t, 0, s.BaseUnitWritten)
	assert.Equal(t, "g", reload(t, db, item.ID).BaseUnit)
}

// TestRunDryRunWritesNothing pins the inspection mode: it must report the same
// plan the real run would apply, and leave every row untouched.
func TestRunDryRunWritesNothing(t *testing.T) {
	db := testDB(t)
	code := "dry-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Dry run drink", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "g", ServingDesc: "1 portion (300 ml)", KcalPer100g: 52,
	})

	off := &fakeOFF{byCode: map[string]*nutrition.FoodItem{code: {BaseUnit: "ml"}}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true, OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitWritten, "a dry run still reports what it would write")
	assert.Equal(t, 1, s.UnitsWritten)
	assert.Equal(t, 1, s.FromParse)

	got := reload(t, db, item.ID)
	assert.Equal(t, "g", got.BaseUnit, "a dry run must not write base_unit")
	assert.Empty(t, units.DecodeServingUnits(got.ServingUnits), "a dry run must not write serving_units")
}

// TestRunDryRunSamplesCuratedGuesses proves the curated-table guesses — the
// ones that are a category-level assumption rather than the row's own label —
// are reported by name so a human can veto them before ~7,900 rows are
// rewritten.
func TestRunDryRunSamplesCuratedGuesses(t *testing.T) {
	db := testDB(t)
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Basmati rice", Provenance: nutrition.ProvenanceAFCD,
		ServingDesc: "per serving", KcalPer100g: 130,
	})

	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true})
	require.NoError(t, err)

	assert.Equal(t, 1, s.FromFallback)
	assert.Equal(t, 0, s.FromParse)
	require.Len(t, s.FallbackSamples, 1)
	assert.Contains(t, s.FallbackSamples[0], "Basmati rice")
	assert.Empty(t, units.DecodeServingUnits(reload(t, db, item.ID).ServingUnits))
}
