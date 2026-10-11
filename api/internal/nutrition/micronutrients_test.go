package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func fptr(v float64) *float64 { return &v }

// Rows already in prod predate the micronutrient columns, and Insert skips any
// name+brand it has seen, so without a backfill they would never gain them.
func TestBackfillMicronutrientsFillsUnmeasuredColumns(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	existing := FoodItem{
		Name: "Micro Probe, raw", Provenance: ProvenanceAFCD, KcalPer100g: 23,
		NormalizedName: Normalize("Micro Probe, raw"),
		Micros:         Micronutrients{IronMgPer100g: fptr(2.7)},
	}
	require.NoError(t, tx.Create(&existing).Error)

	incoming := []FoodItem{{
		Name: "Micro Probe, raw", Provenance: ProvenanceAFCD,
		Micros: Micronutrients{SodiumMgPer100g: fptr(79), IronMgPer100g: fptr(9.9), VitaminDUgPer100g: fptr(0)},
	}}
	n, err := repo.BackfillMicronutrients(ctx, incoming)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	var got FoodItem
	require.NoError(t, tx.First(&got, "name = ?", "Micro Probe, raw").Error)
	require.Equal(t, 79.0, *got.Micros.SodiumMgPer100g)
	require.Equal(t, 0.0, *got.Micros.VitaminDUgPer100g, "a measured zero is written")
	require.Equal(t, 2.7, *got.Micros.IronMgPer100g, "an existing figure is never overwritten")
	require.Nil(t, got.Micros.CalciumMgPer100g)

	n2, err := repo.BackfillMicronutrients(ctx, incoming)
	require.NoError(t, err)
	require.Zero(t, n2, "backfill must be idempotent")
}

// Figures from another dataset would sit beside this row's macros as if one
// lab measured both.
func TestBackfillMicronutrientsIgnoresOtherProvenance(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)

	owned := FoodItem{
		Name: "Shared Probe", Provenance: ProvenanceAFCD, KcalPer100g: 50,
		NormalizedName: Normalize("Shared Probe"),
	}
	require.NoError(t, tx.Create(&owned).Error)

	n, err := repo.BackfillMicronutrients(context.Background(), []FoodItem{{
		Name: "Shared Probe", Provenance: ProvenanceAUSNUT,
		Micros: Micronutrients{SodiumMgPer100g: fptr(400)},
	}})
	require.NoError(t, err)
	require.Zero(t, n)

	var got FoodItem
	require.NoError(t, tx.First(&got, "name = ?", "Shared Probe").Error)
	require.Nil(t, got.Micros.SodiumMgPer100g)
}

func TestBackfillMicronutrientsSkipsItemsWithNoFigures(t *testing.T) {
	tx := fixtureTx(t)
	n, err := NewRepository(tx).BackfillMicronutrients(context.Background(), []FoodItem{{Name: "Nothing"}})
	require.NoError(t, err)
	require.Zero(t, n)
}
