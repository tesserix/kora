package ingest

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// A named serving must survive the round trip into the exact shape
// units.DecodeServingUnits expects, or the resolver silently sees no servings
// at all — the failure mode is invisible, since an empty decode is also how
// "this food has no servings" looks.
func TestEncodeServingUnitsRoundTripsThroughUnitsDecoder(t *testing.T) {
	raw := encodeServingUnits([]servingUnit{
		{Name: "can", Amount: 1, BaseAmount: 333},
		{Name: "slice", Amount: 2, BaseAmount: 140},
	})
	require.NotNil(t, raw)

	decoded := units.DecodeServingUnits(raw)
	require.Len(t, decoded, 2)
	require.Equal(t, "can", decoded[0].Name)
	require.Equal(t, 333.0, decoded[0].BaseAmount)
	require.Equal(t, 2.0, decoded[1].Amount)
}

// Malformed entries are dropped rather than stored. A zero Amount is the one
// that matters: ai.servingGramsFromPhrase divides by it.
func TestEncodeServingUnitsDropsUnusableEntries(t *testing.T) {
	raw := encodeServingUnits([]servingUnit{
		{Name: "cup", Amount: 1, BaseAmount: 158},
		{Name: "", Amount: 1, BaseAmount: 50},      // nameless — matches nothing
		{Name: "slice", Amount: 0, BaseAmount: 30}, // divide-by-zero
		{Name: "piece", Amount: 1, BaseAmount: 0},  // massless
		{Name: "bar", Amount: -1, BaseAmount: 40},  // negative count
	})
	decoded := units.DecodeServingUnits(raw)
	require.Len(t, decoded, 1)
	require.Equal(t, "cup", decoded[0].Name)

	require.Nil(t, encodeServingUnits(nil), "no servings must leave the column at its default")
	require.Nil(t, encodeServingUnits([]servingUnit{{Name: "x", Amount: 0, BaseAmount: 0}}))
}

// The AUSNUT file is the first source to carry named servings, and the whole
// point of the measures join is that these reach the index. If the file is
// regenerated without the measures workbook this catches it.
func TestAusnutCarriesNamedServings(t *testing.T) {
	items, err := LoadFile(repoFoodDir+"/ausnut.json", nutrition.ProvenanceAUSNUT)
	require.NoError(t, err)

	withUnits, withGrams := 0, 0
	for _, it := range items {
		if len(units.DecodeServingUnits(it.ServingUnits)) > 0 {
			withUnits++
		}
		if it.ServingGrams > 0 {
			withGrams++
		}
	}
	require.Greater(t, withUnits, 2000, "AUSNUT must carry named servings from the measures join")
	require.Greater(t, withGrams, 2000, "AUSNUT must carry a default serving mass")

	byName := map[string]nutrition.FoodItem{}
	for _, it := range items {
		byName[it.Name] = it
	}

	// The case the primary-selection policy exists for: a tablespoon sits
	// beside a cup, and picking the smallest measure blindly would default
	// couscous to ~13 g instead of a real portion — a 12x understatement.
	couscous, ok := byName["Couscous, cooked"]
	require.True(t, ok)
	require.Greater(t, couscous.ServingGrams, 100.0,
		"a spoon-scale measure must not win the primary when a cup exists")

	// Duplicate descriptors collapse: AUSNUT lists four `can` sizes for beer
	// and the resolver takes the first phrase match, so leaving them in would
	// make a logged mass depend on spreadsheet row order.
	beer, ok := byName["Beer, high alcohol (5% v/v & above)"]
	require.True(t, ok)
	seen := map[string]int{}
	for _, u := range units.DecodeServingUnits(beer.ServingUnits) {
		seen[u.Name]++
	}
	for name, n := range seen {
		require.Equalf(t, 1, n, "duplicate serving unit %q", name)
	}
}

// `millilitres` is AUSNUT's label for "a serve, measured by volume" — written
// with Quantity 1 and the PORTION MASS in the gram column. Stored as a named
// unit it would make the resolver read "200 millilitres" as 200 x 105 g.
// This is the guard that keeps it out of every source file, not just today's.
func TestNoSourceStoresAMeasurementUnitAsAServingName(t *testing.T) {
	banned := map[string]bool{
		"millilitres": true, "millilitre": true, "ml": true,
		"grams": true, "gram": true, "g": true,
		"litres": true, "litre": true, "kilograms": true, "kilogram": true,
	}
	for _, name := range SourceFiles() {
		if name == AliasFile {
			continue
		}
		items, err := LoadFile(repoFoodDir+"/"+name, nutrition.ProvenanceAUSNUT)
		require.NoError(t, err)
		for _, it := range items {
			for _, u := range units.DecodeServingUnits(it.ServingUnits) {
				require.Falsef(t, banned[u.Name],
					"%s: %q stores %q as a serving unit — a mass/volume unit name "+
						"makes an entered amount resolve to that many servings", name, it.Name, u.Name)
			}
		}
	}
}

// Rows without measures must omit the serving fields entirely rather than
// emitting zeros, so "no data" stays distinguishable from "zero grams".
func TestAusnutOmitsServingFieldsWhenUnmatched(t *testing.T) {
	items, err := LoadFile(repoFoodDir+"/ausnut.json", nutrition.ProvenanceAUSNUT)
	require.NoError(t, err)
	for _, it := range items {
		if len(units.DecodeServingUnits(it.ServingUnits)) == 0 {
			require.Zerof(t, it.ServingGrams,
				"%s has no named servings but carries a serving mass", it.Name)
		}
	}
	data, err := os.ReadFile(repoFoodDir + "/ausnut.json")
	require.NoError(t, err)
	var raw []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &raw))
	for _, r := range raw {
		if _, ok := r["serving_units"]; !ok {
			require.NotContains(t, r, "serving_grams")
			require.NotContains(t, r, "serving_desc")
		}
	}
}
