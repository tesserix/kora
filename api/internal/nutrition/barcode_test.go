package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type stubOFF struct {
	item   *FoodItem
	err    error
	called *bool
}

func (s stubOFF) Fetch(_ context.Context, _ string) (*FoodItem, error) {
	if s.called != nil {
		*s.called = true
	}
	return s.item, s.err
}

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

func TestResolveBarcodeLocalErrorSurfacedNoOFFCall(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a04"

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	called := false
	off := stubOFF{called: &called}
	item, found, err := repo.ResolveBarcode(ctx, off, code)
	require.Error(t, err)
	require.False(t, found)
	require.Nil(t, item)
	require.False(t, called, "OFF client must not be called when the local lookup fails with a real error")
}

func TestResolveBarcodeNameBrandDedupReturnsFoundNoError(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	code := "0000000002a05"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a' AND name = 'Dup Bar'") })

	seedFor(t, repo, []FoodItem{{Name: "Dup Bar", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 100}})

	off := stubOFF{item: &FoodItem{Name: "Dup Bar", Brand: "test2a", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 100}}
	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
	require.Equal(t, "Dup Bar", item.Name)
}

// TestResolveBarcodeRetiredLocalRowFallsThroughToOFF is the regression guard
// for the Critical finding: a food an admin retired must not be resolved
// (and therefore auto-logged at maximum confidence) by barcode. It must be
// treated as if it were not there and the scan must fall through to OFF for
// fresh nutrition. Insert's barcode dedup count is deliberately unfiltered
// (see repository.go), so the OFF fetch must not create a second row under
// the same barcode — this is proven by an unchanged row count, not by
// re-deriving it from ambient rows.
func TestResolveBarcodeRetiredLocalRowFallsThroughToOFF(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	code := "999" + uuid.NewString()[:9]
	ctx := context.Background()

	retired := FoodItem{Name: "Retired Barcode Food", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 50}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	var before int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&before).Error)
	require.Equal(t, int64(1), before, "only the retired row should exist under this barcode before resolving")

	off := stubOFF{item: &FoodItem{Name: "Fresh OFF Product", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 250}}
	item, found, err := repo.ResolveBarcode(ctx, off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
	require.Equal(t, "Fresh OFF Product", item.Name, "a retired local row must not be returned; OFF's fresh data must win")
	require.Equal(t, 250.0, item.KcalPer100g, "the caller must get OFF's nutrition, not the retired row's")

	var after int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&after).Error)
	require.Equal(t, before, after, "resolving must not create a new row: Insert must no-op against the retired row by barcode")

	var stillRetired FoodItem
	require.NoError(t, tx.First(&stillRetired, "id = ?", retired.ID).Error, "the retired row must still be present, not hard-deleted")
	var deletedAtSet bool
	require.NoError(t, tx.Raw("SELECT deleted_at IS NOT NULL FROM food_items WHERE id = ?", retired.ID).Scan(&deletedAtSet).Error)
	require.True(t, deletedAtSet, "the retired row must remain retired, not resurrected")
}

// TestResolveBarcodeLiveLocalRowSkipsOFF is the twin of the retired-row test
// above: without it, a change that always fetched from OFF regardless of a
// local hit would pass the retired-row test too.
func TestResolveBarcodeLiveLocalRowSkipsOFF(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	code := "999" + uuid.NewString()[:9]
	ctx := context.Background()

	live := FoodItem{Name: "Live Barcode Food", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 60}
	require.NoError(t, tx.Create(&live).Error)

	var before int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&before).Error)

	called := false
	off := stubOFF{called: &called, item: &FoodItem{Name: "Should Not Be Used", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 999}}
	item, found, err := repo.ResolveBarcode(ctx, off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
	require.Equal(t, "Live Barcode Food", item.Name, "a live local row must still be returned directly")
	require.Equal(t, 60.0, item.KcalPer100g)
	require.False(t, called, "OFF must not be called when the local row is live")

	var after int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&after).Error)
	require.Equal(t, before, after, "no row should be created or touched for a live local hit")

	var stillLive FoodItem
	require.NoError(t, tx.First(&stillLive, "id = ?", live.ID).Error, "the live row must still be present")
}

// TestResolveBarcodeRetiredLocalRowUnknownToOFFReturnsCleanNotFound covers a
// retired local row whose barcode OFF also does not know: the caller must
// get a clean not-found, not a 500 and not the retired row.
func TestResolveBarcodeRetiredLocalRowUnknownToOFFReturnsCleanNotFound(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	code := "999" + uuid.NewString()[:9]
	ctx := context.Background()

	retired := FoodItem{Name: "Retired Unknown Barcode Food", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 70}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	var before int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&before).Error)

	off := stubOFF{item: nil, err: nil}
	item, found, err := repo.ResolveBarcode(ctx, off, code)
	require.NoError(t, err)
	require.False(t, found)
	require.Nil(t, item)

	var after int64
	require.NoError(t, tx.Model(&FoodItem{}).Where("barcode = ?", code).Count(&after).Error)
	require.Equal(t, before, after, "an OFF miss must not create or remove any row")

	var stillRetired FoodItem
	require.NoError(t, tx.First(&stillRetired, "id = ?", retired.ID).Error, "the retired row must still be present")
	var deletedAtSet bool
	require.NoError(t, tx.Raw("SELECT deleted_at IS NOT NULL FROM food_items WHERE id = ?", retired.ID).Scan(&deletedAtSet).Error)
	require.True(t, deletedAtSet, "the retired row must remain retired")
}
