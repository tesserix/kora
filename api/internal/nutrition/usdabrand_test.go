package nutrition

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSplitEmbeddedBrandExtractsUSDABrands(t *testing.T) {
	cases := []struct {
		name      string
		wantBrand string
		wantRest  string
		why       string
	}{
		{"McDONALD'S, FILET-O-FISH", "McDONALD'S", "FILET-O-FISH",
			"the Mc exception — USDA writes a lowercase c, so an all-uppercase test would miss 45 rows"},
		{"KFC, biscuit", "KFC", "biscuit", "the plain `BRAND, item` shape"},
		{"BURGER KING, french fries", "BURGER KING", "french fries", "a two-word brand"},
		{"SILK Chocolate, soymilk", "SILK", "Chocolate, soymilk",
			"no comma after the brand — the food word ends the run, and the comma inside the food name is kept"},
		{"LITTLE CAESARS 14\" Original Round Cheese Pizza", "LITTLE CAESARS", "14\" Original Round Cheese Pizza",
			"a size token must END the brand, not extend it"},
		{"T.G.I. FRIDAY'S, chicken fingers, from kids' menu", "T.G.I. FRIDAY'S", "chicken fingers, from kids' menu",
			"punctuation inside a brand token"},
		{"CHICK-FIL-A, Chick-n-Strips", "CHICK-FIL-A", "Chick-n-Strips", "hyphenated brand"},
		{"SCHIFF,TIGER'S MILK BAR", "SCHIFF", "TIGER'S MILK BAR", "no space after the comma"},
		{"WEND'YS, Crispy Chicken Sandwich", "WEND'YS", "Crispy Chicken Sandwich",
			"a misspelling in USDA's own data, preserved verbatim rather than corrected"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			brand, rest := SplitEmbeddedBrand(c.name)
			require.Equal(t, c.wantBrand, brand, c.why)
			require.Equal(t, c.wantRest, rest, c.why)
		})
	}
}

// TestSplitEmbeddedBrandFindsNoBrandInGenericNames is the important direction.
// A false positive relabels lab reference data as a branded retail product,
// which is worse than failing to spot a brand: it corrupts entity_type for a row
// that was previously correct.
func TestSplitEmbeddedBrandFindsNoBrandInGenericNames(t *testing.T) {
	generic := []string{
		"Beef, ground, 80% lean meat / 20% fat, raw",
		"Spinach, raw",
		"Rice, white, long-grain, regular, raw, unenriched",
		"Oil, olive, salad or cooking",
		"Egg, whole, cooked, hard-boiled",
		"Cheese, cheddar",
		"A",              // single letter: too short to be a brand
		"AB",             // two letters: still below the floor
		"Mcdonalds soup", // not the Mc exception — the tail is not uppercase
		"",
	}
	for _, name := range generic {
		t.Run(name, func(t *testing.T) {
			brand, rest := SplitEmbeddedBrand(name)
			require.Empty(t, brand, "must not invent a brand for a generic name")
			require.Equal(t, name, rest, "a name with no brand must be returned untouched")
		})
	}
}

// TestSplitEmbeddedBrandAgainstCommittedSRLegacy runs the rule over the real
// committed dataset. It pins the two numbers that make the rule safe to trust —
// how many rows it fires on, and that it never leaves a row without a name —
// so that regenerating usda_sr_legacy.json cannot silently change either.
func TestSplitEmbeddedBrandAgainstCommittedSRLegacy(t *testing.T) {
	path := filepath.Join("..", "..", "data", "food", "usda_sr_legacy.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("committed SR Legacy file not readable: %v", err)
	}
	var rows []struct {
		Name string `json:"name"`
	}
	require.NoError(t, json.Unmarshal(data, &rows))
	require.NotEmpty(t, rows)

	brands := map[string]int{}
	for _, r := range rows {
		brand, rest := SplitEmbeddedBrand(r.Name)
		if brand == "" {
			continue
		}
		brands[brand]++
		require.NotEmpty(t, rest, "extracting a brand must never leave the row nameless: %q", r.Name)
	}

	var matched int
	for _, n := range brands {
		matched += n
	}
	// Measured against the file committed with this change. If a regenerated
	// dataset moves these, look at the new brand list before updating them —
	// a jump would most likely mean the rule started firing on generic rows.
	require.Equal(t, 310, matched, "rows with an embedded brand")
	require.Equal(t, 44, len(brands), "distinct embedded brands")
	require.Contains(t, brands, "McDONALD'S")
	require.Contains(t, brands, "KFC")
}

// TestBackfillUSDAEmbeddedBrandsIsIdempotentAndRetypes covers the property that
// makes this safe to run against a live index: it rewrites an affected row once,
// and a second run changes nothing. Without that, a re-run of cmd/ingest would
// keep finding rows to "fix".
//
// It also pins the consequence the whole change exists for — the row stops
// being typed as generic reference data — and that normalized_name is
// recomputed, since the full-text tier matches on it and a stale value would
// leave the row findable only under its old, brand-prefixed name.
func TestBackfillUSDAEmbeddedBrandsIsIdempotentAndRetypes(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)

	branded := FoodItem{
		Name: "McDONALD'S, FILET-O-FISH", Provenance: ProvenanceUSDA, KcalPer100g: 250,
	}
	require.NoError(t, tx.Create(&branded).Error)
	generic := FoodItem{
		Name: "Spinach, raw", Provenance: ProvenanceUSDA, KcalPer100g: 23,
	}
	require.NoError(t, tx.Create(&generic).Error)

	// Assertions are scoped to the two seeded rows rather than to the returned
	// count. `go test` runs packages in parallel against one database, and this
	// transaction reads at READ COMMITTED, so rows another package commits
	// mid-test can become visible and make any global count flaky.
	//
	// Scoping the assertions is also what lets this run without TRUNCATE-ing
	// food_items first (kora#151). BackfillUSDAEmbeddedBrands is table-wide, so
	// it does touch ambient rows — but only inside this transaction, which is
	// rolled back, and only to apply the same rewrite cmd/ingest already
	// applied to them, which is the idempotency this test is asserting.
	_, err := repo.BackfillUSDAEmbeddedBrands(context.Background())
	require.NoError(t, err)

	var got FoodItem
	require.NoError(t, tx.First(&got, "id = ?", branded.ID).Error)
	require.Equal(t, "McDONALD'S", got.Brand)
	require.Equal(t, "FILET-O-FISH", got.Name)
	require.Equal(t, Normalize("FILET-O-FISH"), got.NormalizedName,
		"normalized_name must follow the new name or full-text still matches the old one")
	require.Equal(t, EntityTypeBrandedProduct, got.EntityType,
		"the point of the change: this stops being generic reference data")

	var untouched FoodItem
	require.NoError(t, tx.First(&untouched, "id = ?", generic.ID).Error)
	require.Equal(t, "Spinach, raw", untouched.Name, "a generic row must not be rewritten")
	require.Equal(t, EntityTypeGeneric, untouched.EntityType)

	_, err = repo.BackfillUSDAEmbeddedBrands(context.Background())
	require.NoError(t, err)
	var afterSecondRun FoodItem
	require.NoError(t, tx.First(&afterSecondRun, "id = ?", branded.ID).Error)
	require.Equal(t, got.Brand, afterSecondRun.Brand, "a second run must not re-split an already-split row")
	require.Equal(t, got.Name, afterSecondRun.Name)
	require.Equal(t, got.EntityType, afterSecondRun.EntityType)
}
