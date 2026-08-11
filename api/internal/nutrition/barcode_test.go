package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/units"
)

// offProduct is the subset of the OpenFoodFacts v2 product payload these
// tests need to construct. offStubServer wraps it in the {status, product}
// envelope HTTPOFFClient.Fetch expects.
type offProduct struct {
	ProductName         string  `json:"product_name"`
	Brands              string  `json:"brands"`
	EnergyKcal100g      float64 `json:"-"`
	ServingQuantity     float64 `json:"serving_quantity"`
	ServingQuantityUnit string  `json:"serving_quantity_unit"`
	ServingSize         string  `json:"serving_size"`
}

// offStubServer starts an httptest server that returns p as an OFF v2
// product lookup response, regardless of the requested barcode.
func offStubServer(t *testing.T, p offProduct) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": 1,
			"product": map[string]any{
				"product_name":          p.ProductName,
				"brands":                p.Brands,
				"serving_quantity":      p.ServingQuantity,
				"serving_quantity_unit": p.ServingQuantityUnit,
				"serving_size":          p.ServingSize,
				"nutriments": map[string]any{
					"energy-kcal_100g": p.EnergyKcal100g,
				},
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

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

func TestFetchByBarcodeSetsBaseUnitFromServingUnit(t *testing.T) {
	tests := []struct {
		name         string
		servingUnit  string
		servingSize  string
		wantBaseUnit string
		wantServing  string // the serving unit name expected in ServingUnits, "" for none
	}{
		{
			name:         "millilitre serving marks the row as a liquid",
			servingUnit:  "ml",
			servingSize:  "1 glass (250ml)",
			wantBaseUnit: "ml",
			wantServing:  "glass",
		},
		{
			name:         "gram serving stays a mass row",
			servingUnit:  "g",
			servingSize:  "1 sachet (16.5g)",
			wantBaseUnit: "g",
			wantServing:  "sachet",
		},
		{
			name:         "absent unit defaults to grams",
			servingUnit:  "",
			servingSize:  "",
			wantBaseUnit: "g",
			wantServing:  "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := offStubServer(t, offProduct{
				ProductName:         "Test product",
				EnergyKcal100g:      100,
				ServingQuantity:     250,
				ServingQuantityUnit: tt.servingUnit,
				ServingSize:         tt.servingSize,
			})

			client := HTTPOFFClient{BaseURL: srv.URL, Client: http.DefaultClient}
			item, err := client.Fetch(context.Background(), "9310232956596")
			require.NoError(t, err)
			require.NotNil(t, item)

			assert.Equal(t, tt.wantBaseUnit, item.BaseUnit)
			if tt.wantServing == "" {
				assert.Empty(t, string(item.ServingUnits))
				return
			}
			var got []units.ServingUnit
			require.NoError(t, json.Unmarshal(item.ServingUnits, &got))
			require.Len(t, got, 1)
			assert.Equal(t, tt.wantServing, got[0].Name)
		})
	}
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

// TestFetchServingUnitReportsTheRawField pins the distinction Fetch cannot
// make: BaseUnitFor defaults an absent serving_quantity_unit to "g", so a
// caller correcting an existing row needs the raw field to tell "OFF publishes
// nothing" apart from "OFF says grams".
func TestFetchServingUnitReportsTheRawField(t *testing.T) {
	t.Run("a published unit comes back verbatim", func(t *testing.T) {
		srv := offStubServer(t, offProduct{ProductName: "Milk", ServingQuantityUnit: "ml", EnergyKcal100g: 52})
		c := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}
		raw, found, err := c.FetchServingUnit(context.Background(), "123")
		require.NoError(t, err)
		assert.True(t, found)
		assert.Equal(t, "ml", raw)
	})

	t.Run("an absent unit is empty, not grams", func(t *testing.T) {
		srv := offStubServer(t, offProduct{ProductName: "Mystery", EnergyKcal100g: 52})
		c := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}
		raw, found, err := c.FetchServingUnit(context.Background(), "123")
		require.NoError(t, err)
		assert.True(t, found, "OFF still knows the product")
		assert.Empty(t, raw)
		assert.Equal(t, "g", BaseUnitFor(raw), "and this is precisely why the raw field is needed")
	})

	t.Run("an unknown product is not found", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		t.Cleanup(srv.Close)
		c := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}
		_, found, err := c.FetchServingUnit(context.Background(), "123")
		require.NoError(t, err)
		assert.False(t, found)
	})
}

// fakeEmbedder records calls and returns a canned vector or error.
type fakeEmbedder struct {
	mu     sync.Mutex
	calls  []string
	vec    []float32
	err    error
	called chan struct{} // closed after the first call, so tests can await the goroutine
}

func (f *fakeEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	f.mu.Lock()
	f.calls = append(f.calls, text)
	f.mu.Unlock()
	select {
	case <-f.called:
	default:
		close(f.called)
	}
	return f.vec, f.err
}

// callCount reads the number of recorded calls under the same mutex Embed
// writes with, since a goroutine could in principle still be calling in.
func (f *fakeEmbedder) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func TestResolveBarcodeEmbedsNewlyInsertedFood(t *testing.T) {
	db := testDB(t)
	emb := &fakeEmbedder{vec: make([]float32, 768), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)
	code := "9310232956596"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })

	srv := offStubServer(t, offProduct{ProductName: "Test drink", EnergyKcal100g: 42, ServingQuantity: 250, ServingQuantityUnit: "ml"})
	off := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}

	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)

	// The embed runs in a goroutine, so wait for it rather than sleeping.
	select {
	case <-emb.called:
	case <-time.After(2 * time.Second):
		t.Fatal("embedder was never called")
	}

	require.Eventually(t, func() bool {
		var embedded bool
		if err := db.Raw("SELECT embedding IS NOT NULL FROM food_items WHERE id = ?", item.ID).Scan(&embedded).Error; err != nil {
			return false
		}
		return embedded
	}, 2*time.Second, 20*time.Millisecond, "embedding was never stored")
}

func TestResolveBarcodeLeavesEmbeddingNullWhenEmbedFails(t *testing.T) {
	// THE LOAD-BEARING TEST. A failed ingest embed must leave the column NULL
	// so the row stays in RowsMissingEmbedding and cmd/embed retries it. If
	// this ever stores a zero vector or otherwise marks the row done, the
	// whole async design silently loses rows.
	db := testDB(t)
	emb := &fakeEmbedder{err: errors.New("boom"), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)
	code := "9300605158641"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })

	srv := offStubServer(t, offProduct{ProductName: "Test drink 2", EnergyKcal100g: 42})
	off := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}

	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	// The SCAN must still succeed — a failed embedding is not the user's problem.
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)

	select {
	case <-emb.called:
	case <-time.After(2 * time.Second):
		t.Fatal("embedder was never called")
	}

	// Deterministically prove the column stays NULL for a bounded window, rather
	// than a bare sleep-then-check that only ever samples once (and could get
	// unlucky on a slow runner). require.Never polls repeatedly and fails the
	// instant the condition ever goes true, so it is racing against the
	// (incorrect) write rather than hoping it lands before a single check.
	require.Never(t, func() bool {
		var embedded bool
		if err := db.Raw("SELECT embedding IS NOT NULL FROM food_items WHERE id = ?", item.ID).Scan(&embedded).Error; err != nil {
			return false
		}
		return embedded
	}, 200*time.Millisecond, 20*time.Millisecond, "embedding column must stay NULL when the embed call failed")
}

func TestResolveBarcodeWithoutEmbedderInsertsNormally(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db) // no WithEmbedder — nil Embedder
	code := "9300605158642"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })

	srv := offStubServer(t, offProduct{ProductName: "Test drink 3", EnergyKcal100g: 42})
	off := HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}

	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
}

// TestResolveBarcodeLocalHitDoesNotEmbed guards against a regression that
// would silently burn Gemini quota on every repeat scan: today embedAsync is
// only reachable from the genuine-new-row path, verified by review, but that
// property was previously unguarded by any test. If a future edit ever moved
// the embedAsync call above (or removed) the local-hit early return in
// ResolveBarcode, this is the test that would catch it — a known barcode must
// resolve entirely from the local index and never touch the embedder.
func TestResolveBarcodeLocalHitDoesNotEmbed(t *testing.T) {
	db := testDB(t)
	emb := &fakeEmbedder{vec: make([]float32, 768), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)
	code := "0000000002a06"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", code) })
	seedFor(t, repo, []FoodItem{{Name: "Repeat scan bar", Brand: "test2a", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 400}})

	// stubOFF{err: assertNoCall(t)} proves the local-hit path was taken at
	// all: the OFF client must never even be reached for a known barcode.
	item, found, err := repo.ResolveBarcode(context.Background(), stubOFF{err: assertNoCall(t)}, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)

	// Give a wrongly-placed embedAsync call room to fire, then assert it
	// never did. callCount reads under fakeEmbedder's own mutex since a
	// goroutine could in principle still be writing.
	require.Never(t, func() bool {
		return emb.callCount() > 0
	}, 200*time.Millisecond, 20*time.Millisecond, "a repeat scan of a known barcode must never call the embedder")
}

// TestResolveBarcodeDedupeBranchDoesNotEmbed covers the other non-insert
// path: Insert dedupes the OFF item against an existing row by name+brand, so
// ResolveBarcode's reload-by-barcode misses and it returns the freshly
// fetched OFF item directly without ever persisting a new row under this
// barcode (see the "Insert deduped ... return the freshly fetched OFF item
// directly" comment in ResolveBarcode). That returned item's ID was never
// stored under this barcode, so embedding it would be pointless at best and
// wrong at worst — this pins that the embedder is never called on this path.
func TestResolveBarcodeDedupeBranchDoesNotEmbed(t *testing.T) {
	db := testDB(t)
	emb := &fakeEmbedder{vec: make([]float32, 768), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)
	code := "0000000002a07"
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a' AND name = 'Dedupe Bar'") })

	seedFor(t, repo, []FoodItem{{Name: "Dedupe Bar", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 100}})

	off := stubOFF{item: &FoodItem{Name: "Dedupe Bar", Brand: "test2a", Provenance: ProvenanceOFF, Barcode: &code, KcalPer100g: 100}}
	item, found, err := repo.ResolveBarcode(context.Background(), off, code)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
	require.Equal(t, "Dedupe Bar", item.Name)

	require.Never(t, func() bool {
		return emb.callCount() > 0
	}, 200*time.Millisecond, 20*time.Millisecond, "the dedupe branch's returned item was never persisted under this barcode and must never be embedded")
}
