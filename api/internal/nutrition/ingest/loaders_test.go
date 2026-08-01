package ingest

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoadFileStampsProvenanceAndSkipsInvalid(t *testing.T) {
	items, err := LoadFile("testdata/sample.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)
	require.Len(t, items, 1) // "Bad Row" (kcal 0) skipped
	require.Equal(t, "Test Oats", items[0].Name)
	require.Equal(t, nutrition.ProvenanceUSDA, items[0].Provenance)
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
