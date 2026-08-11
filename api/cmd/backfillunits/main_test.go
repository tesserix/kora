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
			name:   "unparseable description is skipped rather than guessed at",
			item:   nutrition.FoodItem{Name: "White rice, cooked", ServingDesc: "per serving"},
			wantOK: false,
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

// TestBackfillItemDeclinesCuratedGuesses pins the rule that replaced the
// curated name table: a serving unit is written only where there is evidence
// for it. The table matched a keyword anywhere in a food's name, so a
// USDA-style compound name was claimed by an ingredient it merely mentioned —
// or, worse, by one it explicitly negated. A production dry run planned 639
// such writes, 395 of them on names where the keyword was not the head noun.
func TestBackfillItemDeclinesCuratedGuesses(t *testing.T) {
	guesses := []string{
		"Apples, dried, sulfured, stewed, without added sugar",
		"Chicken, broilers or fryers, breast, meat and skin, cooked, fried, flour",
		"Alcoholic beverage, rice (sake)",
		"Fast foods, submarine sandwich, meatball marinara on white bread",
		// Head-noun matches were no better: restricting the table to these
		// still left 24% of survivors wrong, which is why it is gone entirely.
		"Pork sausage rice links, brown and serve, cooked",
		"Bread, chapati or roti, plain, commercially prepared",
		"Sugar-apples, (sweetsop), raw",
	}
	for _, name := range guesses {
		t.Run(name, func(t *testing.T) {
			_, ok := backfillItem(nutrition.FoodItem{Name: name, ServingDesc: "per serving"})
			assert.False(t, ok, "a category-level guess must never be written")
		})
	}
}

// TestBackfillItemKeepsParsedEvidence guards the other direction: a row's own
// label is evidence, not a guess, and must still be written.
func TestBackfillItemKeepsParsedEvidence(t *testing.T) {
	got, ok := backfillItem(nutrition.FoodItem{Name: "White rice, cooked", ServingDesc: "1 cup (158g)"})
	require.True(t, ok, "a parsed label is evidence and must be written")
	assert.Equal(t, sourceParse, got.Source)

	var parsed []units.ServingUnit
	require.NoError(t, json.Unmarshal(got.Encoded, &parsed))
	require.Len(t, parsed, 1)
	assert.Equal(t, "cup", parsed[0].Name)
	assert.InDelta(t, 158, parsed[0].BaseAmount, 1e-9)
}

// TestRunWritesNoCuratedGuesses is the end-to-end pin: a row the curated table
// would have claimed keeps empty serving_units after a real (non-dry) pass.
func TestRunWritesNoCuratedGuesses(t *testing.T) {
	db := testDB(t)
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Basmati rice", Provenance: nutrition.ProvenanceAFCD,
		ServingDesc: "per serving", KcalPer100g: 130,
	})

	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{})
	require.NoError(t, err)

	assert.Equal(t, 0, s.UnitsWritten)
	assert.Empty(t, units.DecodeServingUnits(reload(t, db, item.ID).ServingUnits),
		"a curated-table name must be left untouched")
}

// TestRunStillCorrectsBaseUnit proves dropping the curated table narrowed only
// the serving_units guesswork. base_unit comes from OpenFoodFacts, which is
// evidence, and correcting it is the whole reason the milk row was wrong.
func TestRunStillCorrectsBaseUnit(t *testing.T) {
	db := testDB(t)
	code := "milk-evidence-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "HIGH PROTEIN LOW FAT MILK", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "g", ServingDesc: "per serving", KcalPer100g: 52,
	})

	off := &fakeOFF{byCode: map[string]string{code: "ml"}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitWritten)
	assert.Equal(t, 0, s.UnitsWritten, "the milk row's own name was a curated-table match and must be declined")
	assert.Equal(t, "ml", reload(t, db, item.ID).BaseUnit)
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
		got, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "g"}, "ml")
		assert.True(t, ok)
		assert.Equal(t, "ml", got)
	})
	t.Run("an already-correct row is not rewritten", func(t *testing.T) {
		_, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "ml"}, "ml")
		assert.False(t, ok)
	})
	// The residual this signature exists for: nutrition.BaseUnitFor maps "" to
	// "g", so planning off the already-defaulted BaseUnit turned "OFF publishes
	// no unit" into "OFF says grams" and downgraded correct ml rows.
	t.Run("an absent serving unit never downgrades a millilitre row", func(t *testing.T) {
		_, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "ml"}, "")
		assert.False(t, ok)
		_, ok = baseUnitPlan(nutrition.FoodItem{BaseUnit: "ml"}, "   ")
		assert.False(t, ok)
	})
	t.Run("an explicit gram unit still corrects a millilitre row", func(t *testing.T) {
		got, ok := baseUnitPlan(nutrition.FoodItem{BaseUnit: "ml"}, "g")
		assert.True(t, ok)
		assert.Equal(t, "g", got)
	})
}

// fakeOFF is a ServingUnitFetcher double: it answers raw serving units from a
// barcode map and can be made to fail or to forget a product, so the job's
// skip-and-continue behaviour is testable. A barcode present in byCode with an
// empty string is a product OFF still knows but publishes no unit for.
type fakeOFF struct {
	byCode map[string]string
	fail   map[string]bool
	calls  []string
}

func (f *fakeOFF) FetchServingUnit(ctx context.Context, barcode string) (string, bool, error) {
	f.calls = append(f.calls, barcode)
	if f.fail[barcode] {
		return "", false, errors.New("off unreachable")
	}
	raw, found := f.byCode[barcode]
	return raw, found, nil
}

var _ nutrition.ServingUnitFetcher = (*fakeOFF)(nil)

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

	off := &fakeOFF{byCode: map[string]string{code: "ml"}}
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

	off := &fakeOFF{byCode: map[string]string{code: "ml"}}
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

	off := &fakeOFF{byCode: map[string]string{code: "ml"}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true, OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitWritten, "a dry run still reports what it would write")
	assert.Equal(t, 1, s.UnitsWritten)
	assert.Equal(t, 1, s.FromParse)

	got := reload(t, db, item.ID)
	assert.Equal(t, "g", got.BaseUnit, "a dry run must not write base_unit")
	assert.Empty(t, units.DecodeServingUnits(got.ServingUnits), "a dry run must not write serving_units")
}

// TestRunLeavesAMillilitreRowAloneWhenOFFPublishesNoUnit is the regression pin
// for the residual: nutrition.BaseUnitFor maps an absent serving_quantity_unit
// to "g", so planning off the already-defaulted BaseUnit made "OFF no longer
// publishes a unit" indistinguishable from "OFF says grams" — and the job
// would have written g over this correctly-ml row, re-creating the exact bug
// it exists to undo.
func TestRunLeavesAMillilitreRowAloneWhenOFFPublishesNoUnit(t *testing.T) {
	db := testDB(t)
	code := "no-unit-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Drink OFF forgot the unit for", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "ml", ServingDesc: "per serving", KcalPer100g: 40,
	})

	// OFF still knows the product; it just publishes no serving_quantity_unit.
	off := &fakeOFF{byCode: map[string]string{code: ""}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitAbsent)
	assert.Equal(t, 0, s.BaseUnitWritten)
	assert.Equal(t, 0, s.BaseUnitFailed, "an absent unit is not a fetch failure")
	assert.Equal(t, "ml", reload(t, db, item.ID).BaseUnit, "absent evidence must never downgrade a correct row")
}

// TestRunDryRunNamesBaseUnitTransitions makes a dry run reviewable: a bare
// count of base_unit changes tells nobody WHICH rows would be rewritten.
func TestRunDryRunNamesBaseUnitTransitions(t *testing.T) {
	db := testDB(t)
	code := "named-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Correctable drink", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "g", ServingDesc: "per serving", KcalPer100g: 40,
	})

	off := &fakeOFF{byCode: map[string]string{code: "ml"}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true, OFF: off})
	require.NoError(t, err)

	require.Len(t, s.BaseUnitSamples, 1)
	assert.Contains(t, s.BaseUnitSamples[0], "Correctable drink")
	assert.Contains(t, s.BaseUnitSamples[0], "g → ml")
	assert.Empty(t, s.BaseUnitDowngrades, "a g → ml correction is not a downgrade")
}

// TestRunReportsAMillilitreDowngradeSeparately keeps the one change that must
// never slip past a dry run unseen out of the capped sample list.
func TestRunReportsAMillilitreDowngradeSeparately(t *testing.T) {
	db := testDB(t)
	code := "downgrade-" + uuid.NewString()
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Relabelled drink", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, BaseUnit: "ml", ServingDesc: "per serving", KcalPer100g: 40,
	})

	// OFF explicitly says grams — the only basis on which a downgrade is
	// allowed to happen at all.
	off := &fakeOFF{byCode: map[string]string{code: "g"}}
	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true, OFF: off})
	require.NoError(t, err)

	assert.Equal(t, 1, s.BaseUnitWritten)
	require.Len(t, s.BaseUnitDowngrades, 1)
	assert.Contains(t, s.BaseUnitDowngrades[0], "Relabelled drink")
	assert.Contains(t, s.BaseUnitDowngrades[0], "ml → g")
	assert.Empty(t, s.BaseUnitSamples, "a downgrade is reported louder, not twice")
}

// TestRunDryRunPlansNothingForACuratedName is the counterpart to the old
// curated-guess sampling: there is no longer anything to sample, because a
// name the table would have claimed now plans no write at all.
func TestRunDryRunPlansNothingForACuratedName(t *testing.T) {
	db := testDB(t)
	item := seedItem(t, db, nutrition.FoodItem{
		Name: "Basmati rice", Provenance: nutrition.ProvenanceAFCD,
		ServingDesc: "per serving", KcalPer100g: 130,
	})

	s, err := run(context.Background(), db.Where("id = ?", item.ID), options{DryRun: true})
	require.NoError(t, err)

	assert.Equal(t, 0, s.UnitsWritten)
	assert.Equal(t, 0, s.FromParse)
	assert.Equal(t, 1, s.Skipped)
	assert.Empty(t, units.DecodeServingUnits(reload(t, db, item.ID).ServingUnits))
}
