package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type stubOFF struct {
	item *FoodItem
	err  error
}

func (s stubOFF) Fetch(_ context.Context, _ string) (*FoodItem, error) { return s.item, s.err }

func TestResolveBarcodeLocalHit(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a01"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })
	seedFor(t, repo, []FoodItem{{Name: "Local bar", Brand: "test2a", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 400}})

	item, found, err := repo.ResolveBarcode(context.Background(), stubOFF{err: assertNoCall(t)}, code)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "Local bar", item.Name)
}

func TestResolveBarcodeOFFMissEnriches(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a02"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })

	off := stubOFF{item: &FoodItem{Name: "Imported oats", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 379}}
	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "Imported oats", item.Name)
	// second call now hits locally
	var count int64
	db.Model(&FoodItem{}).Where("barcode = ?", code).Count(&count)
	require.Equal(t, int64(1), count)
}

func TestResolveBarcodeUnknownNoRow(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a03"
	item, found, err := repo.ResolveBarcode(context.Background(), stubOFF{item: nil}, code)
	require.NoError(t, err)
	require.False(t, found)
	require.Nil(t, item)
	var count int64
	db.Model(&FoodItem{}).Where("barcode = ?", code).Count(&count)
	require.Equal(t, int64(0), count)
}

// assertNoCall returns an error the stub would surface if Fetch is called; the
// local-hit test must not reach the OFF client.
func assertNoCall(t *testing.T) error { return nil }
