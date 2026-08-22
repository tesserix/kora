package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func barcoded(code, name string, kcal float64) FoodItem {
	return FoodItem{
		Name: name, Brand: "Acme", Provenance: ProvenanceOFF, Barcode: &code,
		KcalPer100g: kcal, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2,
	}
}

func TestUpsertBarcodedInsertsUpdatesAndSkipsUnchanged(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)
	ctx := context.Background()

	ins, upd, err := repo.UpsertBarcoded(ctx, []FoodItem{barcoded("9310001000001", "Acme Bar", 400)})
	require.NoError(t, err)
	require.Equal(t, 1, ins)
	require.Equal(t, 0, upd)

	// Same payload again: nothing changed, nothing written.
	ins, upd, err = repo.UpsertBarcoded(ctx, []FoodItem{barcoded("9310001000001", "Acme Bar", 400)})
	require.NoError(t, err)
	require.Zero(t, ins)
	require.Zero(t, upd)

	// Reformulated: kcal and name change land, normalized fields follow.
	ins, upd, err = repo.UpsertBarcoded(ctx, []FoodItem{barcoded("9310001000001", "Acme Bar Original", 380)})
	require.NoError(t, err)
	require.Zero(t, ins)
	require.Equal(t, 1, upd)
	var got FoodItem
	require.NoError(t, tx.Where("barcode = ?", "9310001000001").First(&got).Error)
	require.Equal(t, 380.0, got.KcalPer100g)
	require.Equal(t, "Acme Bar Original", got.Name)
	require.Equal(t, Normalize("Acme Bar Original"), got.NormalizedName)
}

func TestUpsertBarcodedRespectsRetiredRows(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)
	ctx := context.Background()

	_, _, err := repo.UpsertBarcoded(ctx, []FoodItem{barcoded("9310001000002", "Retired Bar", 400)})
	require.NoError(t, err)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE barcode = '9310001000002'").Error)

	// Upstream re-publishing a retired product must neither resurrect nor
	// update it — admin retirement wins over the refresh, same as Insert.
	ins, upd, err := repo.UpsertBarcoded(ctx, []FoodItem{barcoded("9310001000002", "Retired Bar", 500)})
	require.NoError(t, err)
	require.Zero(t, ins)
	require.Zero(t, upd)
	var n int64
	require.NoError(t, tx.Raw("SELECT count(*) FROM food_items WHERE barcode = '9310001000002' AND deleted_at IS NULL").Scan(&n).Error)
	require.Zero(t, n)
}

func TestLocalePrefers(t *testing.T) {
	require.True(t, LocalePrefers(LocaleAU, LocaleAU))
	require.True(t, LocalePrefers(LocaleNZ, LocaleNZ))
	// FSANZ is bi-national: NZ users lean on AU reference data.
	require.True(t, LocalePrefers(LocaleNZ, LocaleAU))
	// One-way: AU has ample native coverage.
	require.False(t, LocalePrefers(LocaleAU, LocaleNZ))
	// Unknown on either side must never boost.
	require.False(t, LocalePrefers(LocaleUnknown, LocaleUnknown))
	require.False(t, LocalePrefers(LocaleAU, LocaleUnknown))
	require.False(t, LocalePrefers(LocaleUnknown, LocaleAU))
}
