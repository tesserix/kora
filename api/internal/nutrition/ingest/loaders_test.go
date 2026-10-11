package ingest

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoadFileStampsProvenanceAndSkipsInvalid(t *testing.T) {
	items, err := LoadFile("testdata/sample.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)

	// Unnamed and NEGATIVE-energy rows are dropped; a row at exactly 0 kcal is
	// KEPT. Zero is a real measurement, not missing data, and conflating the
	// two removed every zero-energy food from the index — water, mineral
	// water, black tea and coffee — which is why "water" used to resolve to
	// `Coconut Water` at 15.3 kcal.
	require.Len(t, items, 2)
	require.Equal(t, "Test Oats", items[0].Name)
	require.Equal(t, "Test Water", items[1].Name, "a genuinely zero-energy food must survive ingest")
	require.Zero(t, items[1].KcalPer100g)
	for _, it := range items {
		require.Equal(t, nutrition.ProvenanceUSDA, it.Provenance)
	}
}

// The generated SR Legacy file is committed data the image ships; if it is
// missing or malformed the prod food index silently loses ~7,800 items.
func TestLoadFileParsesGeneratedSRLegacy(t *testing.T) {
	items, err := LoadFile("../../../data/food/usda_sr_legacy.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)
	require.Greater(t, len(items), 7000)
	for _, it := range items[:50] {
		require.NotEmpty(t, it.Name)
		require.Greater(t, it.KcalPer100g, 0.0)
		require.Equal(t, nutrition.ProvenanceUSDA, it.Provenance)
	}
}

// The curated set exists because SR Legacy has zero coverage of these foods.
// If it stops loading, Australian and Indian users lose their entire index.
func TestLoadFileParsesCuratedDishes(t *testing.T) {
	items, err := LoadFile("../../../data/food/au_in_dishes.json", nutrition.ProvenanceCurated)
	require.NoError(t, err)
	require.Greater(t, len(items), 30)

	byName := map[string]nutrition.FoodItem{}
	for _, it := range items {
		require.Equal(t, nutrition.ProvenanceCurated, it.Provenance)
		require.Greater(t, it.KcalPer100g, 0.0)
		require.Greater(t, it.ServingGrams, 0.0)
		byName[it.Name] = it
	}
	for _, want := range []string{"Dal tadka", "Plain dosa", "Idli, steamed", "Butter chicken"} {
		_, ok := byName[want]
		require.True(t, ok, "curated set must contain %q", want)
	}
}

// Micronutrients are optional per source: an absent figure must load as nil,
// never 0, or every unmeasured food would read as sodium- and vitamin-free.
func TestLoadFileKeepsMicronutrientsAndLeavesMissingNil(t *testing.T) {
	items, err := LoadFile("testdata/micronutrients.json", nutrition.ProvenanceAFCD)
	require.NoError(t, err)
	require.Len(t, items, 2)

	m := items[0].Micros
	require.Equal(t, 0.4, *m.SugarPer100g)
	require.Equal(t, 0.06, *m.SatFatPer100g)
	require.Equal(t, 79.0, *m.SodiumMgPer100g)
	require.Equal(t, 0.0, *m.CholesterolMgPer100g, "a measured zero must stay a zero")
	require.Equal(t, 99.0, *m.CalciumMgPer100g)
	require.Equal(t, 2.71, *m.IronMgPer100g)
	require.Equal(t, 558.0, *m.PotassiumMgPer100g)
	require.Equal(t, 469.0, *m.VitaminAUgPer100g)
	require.Equal(t, 28.1, *m.VitaminCMgPer100g)
	require.Equal(t, 0.0, *m.VitaminDUgPer100g)

	require.True(t, items[1].Micros.Empty(), "an unmeasured row must carry no figures")
	require.Nil(t, items[1].Micros.SodiumMgPer100g)
}

// The reference files ship micronutrients; a converter regression that drops
// them would silently blank sodium and vitamins across the index.
func TestCommittedReferenceFilesCarryMicronutrients(t *testing.T) {
	for file, prov := range map[string]string{
		"afcd_release3.json": nutrition.ProvenanceAFCD, "ausnut.json": nutrition.ProvenanceAUSNUT,
		"ifct.json": nutrition.ProvenanceIFCT, "usda_fndds.json": nutrition.ProvenanceUSDA,
		"usda_sr_legacy.json": nutrition.ProvenanceUSDA, "off_au.json": nutrition.ProvenanceOFF,
	} {
		items, err := LoadFile("../../../data/food/"+file, prov)
		require.NoError(t, err)
		withSodium := 0
		for _, it := range items {
			if it.Micros.SodiumMgPer100g != nil {
				withSodium++
			}
		}
		require.Greater(t, withSodium*10, len(items)*9, "%s: under 90%% of rows state sodium", file)
	}
}
