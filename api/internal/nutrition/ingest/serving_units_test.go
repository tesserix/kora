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
	// Lower than withUnits ON PURPOSE. primary_serving abstains when a food's
	// measures disagree about what a serving is, so ~700 foods carry named
	// units but no default and fall back to the flat 100 g.
	require.Greater(t, withGrams, 1500, "AUSNUT must carry a default serving mass")
	require.Less(t, withGrams, withUnits, "abstention is expected, not a bug")

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

// The regression guard. Two primary-selection rules shipped wrong answers in
// opposite directions before this one:
//
//	smallest -> one piece of a food eaten in handfuls. AUSNUT publishes
//	            "1 pea" (1 g), "1 leaf" (1 g), "1 chip" (3.9 g), and 213 rows
//	            landed under 5 g. A plate of hot chips resolved to 7 KCAL in
//	            production.
//	nearest a -> a cup of a food eaten by the teaspoon. `Sauce, tomato` got a
//	260 g "1 cup" where the 10 g packet was right.
//
// Neither was caught by spot-checking individual foods, because the cases I
// picked (beer, couscous, pizza) all happened to be foods whose smallest
// measure IS a serving. A distribution check finds it instantly, which is why
// this asserts over every row rather than over a chosen few.
// Scoped to ausnut.json deliberately. Other sources state servings taken from
// real packaging, where small IS correct — OpenFoodFacts has "English
// Breakfast Tea" at 2 g, which is a tea bag and right. The claim here is only
// about the masses THIS converter derives from AUSNUT's measure list.
func TestNoImplausiblySmallDefaultServing(t *testing.T) {
	items, err := LoadFile(repoFoodDir+"/ausnut.json", nutrition.ProvenanceAUSNUT)
	require.NoError(t, err)
	for _, it := range items {
		if it.ServingGrams <= 0 {
			continue
		}
		require.GreaterOrEqualf(t, it.ServingGrams, 5.0,
			"%q defaults to %.1f g — that is one piece of a food, not a serving",
			it.Name, it.ServingGrams)
	}
}

// Where AUSNUT's measures disagree about what a serving is, the converter must
// emit NO default rather than choose. Chips list a 3.9 g chip beside a 100 g
// takeaway serve and a 320 g bucket; tomato sauce lists a 10 g packet beside a
// 260 g cup. Both previously produced a confidently wrong number.
func TestAusnutAbstainsWhenMeasuresDisagree(t *testing.T) {
	items, err := LoadFile(repoFoodDir+"/ausnut.json", nutrition.ProvenanceAUSNUT)
	require.NoError(t, err)
	byName := map[string]nutrition.FoodItem{}
	for _, it := range items {
		byName[it.Name] = it
	}
	for _, name := range []string{
		"Potato, chips, takeaway outlet, deep fried, blended oil, salted",
		"Sauce, tomato, commercial, regular",
		"Pizza, meat & vegetable (e.g. supreme), takeaway",
	} {
		it, ok := byName[name]
		require.Truef(t, ok, "%s missing from the index", name)
		require.Zerof(t, it.ServingGrams,
			"%s must abstain: its measures describe different servings", name)
		require.NotEmptyf(t, units.DecodeServingUnits(it.ServingUnits),
			"%s must still carry its named units so \"2 slices\" resolves", name)
	}
}
