package nutrition

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBarcodeLookupRetainsNutrientsInCanonicalUnits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":1,"product":{"product_name":"Labelled food","countries_tags":["en:japan"],"nutriments":{"energy-kcal_100g":100,"sugars_100g":0,"sodium_100g":0.42,"vitamin-d_100g":0.000005}}}`)
	}))
	defer srv.Close()
	item, err := (HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}).Fetch(t.Context(), "4000000000000")
	require.NoError(t, err)
	require.NotNil(t, item)
	encoded, err := json.Marshal(item)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(encoded, &got))
	require.Equal(t, 420.0, got["sodium_mg_per_100g"])
	require.Equal(t, 0.0, got["sugar_per_100g"])
	require.Equal(t, 5.0, got["vitamin_d_ug_per_100g"])
	_, known := got["cholesterol_mg_per_100g"]
	require.False(t, known)
}

func TestUpsertNutrientsKeepsUnknownMeasurementsAndUpdatesMeasuredZero(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	value, code := 420.0, "4009999999999"
	item := FoodItem{Name: "Nutrient upsert fixture", Brand: "nutrient-fixture", Barcode: &code, Provenance: ProvenanceOFF, KcalPer100g: 100, Nutrients: Nutrients{SodiumMgPer100g: &value}}
	_, err := repo.Insert(t.Context(), []FoodItem{item})
	require.NoError(t, err)
	zero := 0.0
	item.SugarPer100g = &zero
	item.SodiumMgPer100g = nil
	_, updated, err := repo.UpsertBarcoded(t.Context(), []FoodItem{item})
	require.NoError(t, err)
	require.Equal(t, 1, updated)
	var got FoodItem
	require.NoError(t, tx.First(&got, "barcode = ?", code).Error)
	require.Equal(t, 420.0, *got.SodiumMgPer100g)
	require.NotNil(t, got.SugarPer100g)
	require.Zero(t, *got.SugarPer100g)
	_, updated, err = repo.UpsertBarcoded(t.Context(), []FoodItem{item})
	require.NoError(t, err)
	require.Zero(t, updated)
}

func TestNutrientBackfillUsesBarcodeAfterAProductRename(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	code := "4009999999998"
	old := FoodItem{Name: "Old product name", Brand: "Old brand", Barcode: &code, Provenance: ProvenanceOFF, KcalPer100g: 100}
	_, err := repo.Insert(t.Context(), []FoodItem{old})
	require.NoError(t, err)
	sodium := 420.0
	next := FoodItem{Name: "New product name", Brand: "New brand", Barcode: &code, Provenance: ProvenanceOFF, Nutrients: Nutrients{SodiumMgPer100g: &sodium}}
	updated, err := repo.BackfillNutrients(t.Context(), []FoodItem{next})
	require.NoError(t, err)
	require.Equal(t, 1, updated)
	var got FoodItem
	require.NoError(t, tx.First(&got, "barcode = ?", code).Error)
	require.Equal(t, "Old product name", got.Name)
	require.Equal(t, 420.0, *got.SodiumMgPer100g)
}

func TestBarcodeLookupRejectsAnOversizedUpstreamResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"padding":%q,"status":1,"product":{"product_name":"Food","nutriments":{"energy-kcal_100g":100}}}`, strings.Repeat("x", 2<<20))
	}))
	defer srv.Close()
	item, err := (HTTPOFFClient{BaseURL: srv.URL, Client: srv.Client()}).Fetch(t.Context(), "4000000000000")
	require.Error(t, err)
	require.Nil(t, item)
}
