package ingest

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoadFilePreservesMeasuredNutrientsAndUnknowns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foods.json")
	require.NoError(t, os.WriteFile(path, []byte(`[
		{"name":"Measured food","kcal_per_100g":100,"sugar_per_100g":0,"sodium_mg_per_100g":420,"vitamin_a_rae_ug_per_100g":12},
		{"name":"Unknown food","kcal_per_100g":100}
	]`), 0600))
	items, err := LoadFile(path, "usda")
	require.NoError(t, err)
	require.Len(t, items, 2)
	encoded, err := json.Marshal(items)
	require.NoError(t, err)
	var got []map[string]any
	require.NoError(t, json.Unmarshal(encoded, &got))
	require.Equal(t, float64(0), got[0]["sugar_per_100g"])
	require.Equal(t, float64(420), got[0]["sodium_mg_per_100g"])
	require.Equal(t, float64(12), got[0]["vitamin_a_rae_ug_per_100g"])
	require.Nil(t, got[1]["sugar_per_100g"])
}

func TestRunBackfillsOnlyMissingNutrientsFromTheOwningSource(t *testing.T) {
	tx := testDB(t).Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := nutrition.NewRepository(tx)
	path := filepath.Join(t.TempDir(), "food.json")
	write := func(data string) {
		t.Helper()
		require.NoError(t, os.WriteFile(path, []byte(data), 0600))
	}
	write(`[{"name":"Backfill fixture","brand":"nutrient-fixture","kcal_per_100g":100,"sugar_per_100g":0}]`)
	n, err := Run(t.Context(), repo, map[string]string{path: "afcd"})
	require.NoError(t, err)
	require.Equal(t, 1, n)
	write(`[{"name":"Backfill fixture","brand":"nutrient-fixture","kcal_per_100g":999,"sugar_per_100g":5,"sodium_mg_per_100g":120}]`)
	_, err = Run(context.Background(), repo, map[string]string{path: "usda"})
	require.NoError(t, err)
	var got nutrition.FoodItem
	require.NoError(t, tx.First(&got, "brand = ?", "nutrient-fixture").Error)
	require.Nil(t, got.SodiumMgPer100g, "a different source must not fill the owning source's nutrition")
	for range 2 {
		n, err = Run(t.Context(), repo, map[string]string{path: "afcd"})
		require.NoError(t, err)
		require.Zero(t, n, "backfill never duplicates a food")
	}
	require.NoError(t, tx.First(&got, "brand = ?", "nutrient-fixture").Error)
	require.NotNil(t, got.SodiumMgPer100g)
	require.Equal(t, 120.0, *got.SodiumMgPer100g)
	require.Equal(t, 0.0, *got.SugarPer100g, "measured zero must survive reseeding")
	require.Equal(t, 100.0, got.KcalPer100g)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now(), sodium_mg_per_100g = NULL WHERE id = ?", got.ID).Error)
	_, err = Run(t.Context(), repo, map[string]string{path: "afcd"})
	require.NoError(t, err)
	var retired nutrition.FoodItem
	require.NoError(t, tx.First(&retired, "id = ?", got.ID).Error)
	require.Nil(t, retired.SodiumMgPer100g)
}
