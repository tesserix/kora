package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Pure unit tests — no database. That matters here: internal/nutrition's
// database-backed tests truncate the shared dev food_items table (kora#151),
// and nothing in this file may ever give someone a reason to run the whole
// package to check the derivation rule.
func TestDeriveEntityType(t *testing.T) {
	bc := func(s string) *string { return &s }

	cases := []struct {
		name    string
		brand   string
		barcode *string
		want    EntityType
	}{
		// The shape of every USDA and AFCD row in the live index, and of the
		// hand-authored dishes: no brand, no barcode, so nothing identifies a
		// particular seller's version of the food.
		{"reference row, no brand or barcode", "", nil, EntityTypeGeneric},

		// The ordinary OpenFoodFacts row: brand AND barcode.
		{"branded and barcoded", "Sanitarium", bc("9300675024235"), EntityTypeBrandedProduct},

		// The 80 OpenFoodFacts rows with a blank brand ("Gala Apple", "wafer
		// crackers"). A brand-only rule would have called these generic
		// reference data; the barcode says otherwise.
		{"barcode without brand", "", bc("00004173"), EntityTypeBrandedProduct},

		// The 3 curated rows (Tim Tam, Iced VoVo, Milo). Hand-authored because
		// OFF's Australian coverage is poor, but they are retail products and
		// the rule must not care that a human typed them.
		{"brand without barcode", "Arnott's", nil, EntityTypeBrandedProduct},

		// The 11 user_estimate rows are a user's own estimate of a food
		// ("Spaghetti bolognese", "Flat white"), not a retail product.
		{"user estimate", "", nil, EntityTypeGeneric},

		// Whitespace is not a brand or a barcode. An empty-string barcode
		// pointer in particular is reachable: Repository.Insert already treats
		// *item.Barcode == "" as "no barcode" for dedup purposes, so the two
		// must agree on what counts as absent.
		{"whitespace brand", "   ", nil, EntityTypeGeneric},
		{"empty barcode pointer", "", bc(""), EntityTypeGeneric},
		{"whitespace barcode", "", bc("  "), EntityTypeGeneric},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, DeriveEntityType(tc.brand, tc.barcode))
		})
	}
}

// The BeforeCreate hook is the backstop for insert paths that do not exist yet
// (Repository.Insert and admin's CreateFood both set EntityType explicitly).
// It must type an untyped row and must never overwrite an explicit one.
func TestFoodItemBeforeCreateTypesUntypedRows(t *testing.T) {
	barcode := "9300675024235"

	item := FoodItem{Name: "Weet-Bix", Brand: "Sanitarium", Barcode: &barcode}
	require.NoError(t, item.BeforeCreate(nil))
	require.Equal(t, EntityTypeBrandedProduct, item.EntityType)

	plain := FoodItem{Name: "Rolled oats, raw"}
	require.NoError(t, plain.BeforeCreate(nil))
	require.Equal(t, EntityTypeGeneric, plain.EntityType)

	// An explicit value wins: the hook fills a gap, it does not re-derive.
	explicit := FoodItem{Name: "Rolled oats, raw", EntityType: EntityTypeBrandedProduct}
	require.NoError(t, explicit.BeforeCreate(nil))
	require.Equal(t, EntityTypeBrandedProduct, explicit.EntityType)
}

// Repository.Insert is the choke point every bulk source runs through —
// cmd/ingest, cmd/seed and the OpenFoodFacts cache-on-miss in ResolveBarcode.
// This proves the column is actually populated on the way in, and that a
// caller cannot override the rule by supplying its own value.
//
// Uses the rolled-back-transaction pattern documented on
// TestCountExcludesSoftDeleted, and deliberately does NOT truncate: this suite
// must never be another way to lose the shared dev index (kora#151).
func TestInsertTypesRowsAtIngest(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	barcode := "kora212-" + uuid.NewString()
	items := []FoodItem{
		{Name: "EntityType Reference " + uuid.NewString(), Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: "EntityType Branded " + uuid.NewString(), Brand: "Sanitarium", Provenance: ProvenanceOFF, KcalPer100g: 100},
		{Name: "EntityType Barcoded " + uuid.NewString(), Barcode: &barcode, Provenance: ProvenanceOFF, KcalPer100g: 100},
		// A caller that asserts the wrong type must lose to the rule.
		{Name: "EntityType Liar " + uuid.NewString(), EntityType: EntityTypeBrandedProduct, Provenance: ProvenanceAFCD, KcalPer100g: 100},
	}
	want := []EntityType{
		EntityTypeGeneric,
		EntityTypeBrandedProduct,
		EntityTypeBrandedProduct,
		EntityTypeGeneric,
	}

	n, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)
	require.Equal(t, len(items), n)

	for i, item := range items {
		var got string
		require.NoError(t, tx.Raw(
			`SELECT entity_type FROM food_items WHERE name = ?`, item.Name,
		).Scan(&got).Error)
		require.Equal(t, want[i], got, "row %q", item.Name)
	}
}
