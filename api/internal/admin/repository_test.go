package admin

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

// seedTx opens a transaction, registers its rollback immediately (so it runs on
// Goexit too, e.g. a require failure), and inserts controlled rows. Every
// assertion below is made against THIS transaction, so the 85 ambient rows in
// the shared test database can never satisfy or defeat one.
func seedTx(t *testing.T, db *gorm.DB, items ...nutrition.FoodItem) *gorm.DB {
	t.Helper()
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	for i := range items {
		require.NoError(t, tx.Create(&items[i]).Error)
	}
	return tx
}

func food(name, brand string) nutrition.FoodItem {
	return nutrition.FoodItem{
		Name:           name,
		Brand:          brand,
		NormalizedName: name,
		Provenance:     nutrition.ProvenanceCurated,
		ServingDesc:    "1 serve",
		ServingGrams:   100,
		KcalPer100g:    100,
	}
}

func TestListFoodsFiltersByQueryAcrossNameAndBrand(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db,
		food("zzz-admin-oats", "Uncle Tobys"),
		food("zzz-admin-quinoa", "Zzz Oatsbrand"),
		food("zzz-admin-lentils", "Nothing"),
	)
	repo := NewRepository(tx)

	got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-admin-", Limit: 10})
	require.NoError(t, err)
	require.Len(t, got.Items, 3, "the three seeded rows must all match the shared prefix")

	// The discriminating assertion: "oats" must match the NAME of one row and
	// the BRAND of another, and must NOT match the third. If it matched all
	// three or none, this test would prove nothing about the filter.
	got, err = repo.ListFoods(context.Background(), ListParams{Query: "oats", Limit: 10})
	require.NoError(t, err)
	names := map[string]bool{}
	for _, it := range got.Items {
		names[it.Name] = true
	}
	assert.True(t, names["zzz-admin-oats"], "must match on name")
	assert.True(t, names["zzz-admin-quinoa"], "must match on brand")
	assert.False(t, names["zzz-admin-lentils"], "must not match an unrelated row")
}

func TestListFoodsPagesWithStableOrderAndReportsTotal(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db,
		food("zzz-page-c", ""),
		food("zzz-page-a", ""),
		food("zzz-page-b", ""),
	)
	repo := NewRepository(tx)

	first, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-page-", Limit: 2, Offset: 0})
	require.NoError(t, err)
	second, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-page-", Limit: 2, Offset: 2})
	require.NoError(t, err)

	require.Len(t, first.Items, 2)
	require.Len(t, second.Items, 1)
	assert.Equal(t, []string{"zzz-page-a", "zzz-page-b"}, []string{first.Items[0].Name, first.Items[1].Name})
	assert.Equal(t, "zzz-page-c", second.Items[0].Name)

	// Total is the count of MATCHES, not of the returned page — the pager needs
	// to know there are 3 while holding 2.
	assert.Equal(t, int64(3), first.Total)
	assert.Equal(t, int64(3), second.Total)
	assert.NotEqual(t, int64(len(first.Items)), first.Total,
		"if Total equalled the page size this test could not tell the two apart")
}

func TestListFoodsWithNoQueryReturnsEverythingItCanSee(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db, food("zzz-all-one", ""), food("zzz-all-two", ""), food("zzz-all-three", ""))
	repo := NewRepository(tx)

	// This must hold whether the table under it is empty (a freshly migrated
	// CI database) or holds thousands of ambient rows (this shared local
	// database, or production): at least the seeded rows are visible, and the
	// page itself — not just Total — actually contains rows.
	got, err := repo.ListFoods(context.Background(), ListParams{Limit: MaxLimit})
	require.NoError(t, err)
	require.GreaterOrEqual(t, got.Total, int64(3), "at least the three seeded rows must be visible")
	assert.Len(t, got.Items, int(min(got.Total, int64(MaxLimit))),
		"the page must actually be populated, not just report a correct Total")
}

// TestListFoodsExcludesSoftDeleted proves a retired food never appears in the
// admin browse — neither in the returned page nor in Total, which is what
// tells an operator whether a "delete" actually did anything.
func TestListFoodsExcludesSoftDeleted(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db, food("zzz-admin-live", ""), food("zzz-admin-retired", ""))
	var retiredRow nutrition.FoodItem
	require.NoError(t, tx.First(&retiredRow, "name = ?", "zzz-admin-retired").Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retiredRow.ID).Error)
	repo := NewRepository(tx)

	got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-admin-", Limit: 10})
	require.NoError(t, err)

	names := map[string]bool{}
	for _, it := range got.Items {
		names[it.Name] = true
	}
	assert.True(t, names["zzz-admin-live"], "the live row must still be listed")
	assert.False(t, names["zzz-admin-retired"], "a retired row must not be listed")
	assert.Equal(t, int64(1), got.Total, "Total must exclude the retired row too")
}

// TestClampLimitBounds is the load-bearing pin for the limit clamp: it tests
// clampLimit directly, with NO database, so it cannot be defeated by ambient
// row count the way a ListFoods-level, row-count-based assertion can (see
// TestListFoodsClampsLimitByCase's doc comment). It passes identically
// against a freshly migrated empty database and this shared local one,
// because it never touches either. This is what actually catches the
// `p.Limit > MaxLimit` -> `p.Limit > 1<<30` mutation: clampLimit(MaxLimit +
// 800) would return MaxLimit+800 unclamped, not MaxLimit, and the assertion
// below goes red.
func TestClampLimitBounds(t *testing.T) {
	assert.Equal(t, DefaultLimit, clampLimit(0), "unset (zero) must fall back to DefaultLimit")
	assert.Equal(t, DefaultLimit, clampLimit(-5), "negative must fall back to DefaultLimit, same as unset")
	assert.Equal(t, 10, clampLimit(10), "an in-range limit must be honoured exactly")
	assert.Equal(t, MaxLimit, clampLimit(MaxLimit), "exactly MaxLimit must pass through unclamped")
	assert.Equal(t, MaxLimit, clampLimit(MaxLimit+1), "one over MaxLimit must clamp to MaxLimit, not fall back to DefaultLimit")
	assert.Equal(t, MaxLimit, clampLimit(MaxLimit+800), "far over MaxLimit must still clamp to MaxLimit")
}

// TestListFoodsClampsLimitByCase pins the three-way limit branch end-to-end
// through ListFoods and real SQL: unset falls back to DefaultLimit, an
// in-range limit is honoured exactly, and an over-max limit clamps to
// MaxLimit, NOT DefaultLimit. 60 seeded rows sit strictly between
// DefaultLimit (50) and MaxLimit (200), so a page of 50 vs a page of 60 is
// what tells "clamped to max" and "silently fell back to default" apart —
// but NOTE this framing cannot tell "clamped to MaxLimit" apart from "not
// clamped at all", because 60 seeded rows is under MaxLimit either way; that
// gap is what TestClampLimitBounds above exists to close.
func TestListFoodsClampsLimitByCase(t *testing.T) {
	require.Less(t, DefaultLimit, 60, "fixture assumes DefaultLimit < 60 seeded rows")
	require.Less(t, 60, MaxLimit, "fixture assumes 60 seeded rows < MaxLimit")

	db := testDB(t)
	const seeded = 60
	rows := make([]nutrition.FoodItem, seeded)
	for i := range rows {
		rows[i] = food(fmt.Sprintf("zzz-clamp-%02d", i), "")
	}
	tx := seedTx(t, db, rows...)
	repo := NewRepository(tx)

	t.Run("unset limit falls back to DefaultLimit", func(t *testing.T) {
		got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-clamp-", Limit: 0})
		require.NoError(t, err)
		assert.Len(t, got.Items, DefaultLimit)
	})

	t.Run("over-max limit clamps to MaxLimit, not DefaultLimit", func(t *testing.T) {
		got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-clamp-", Limit: MaxLimit + 800})
		require.NoError(t, err)
		// All 60 seeded rows fit under MaxLimit (200). A fallback to
		// DefaultLimit (50) instead of MaxLimit would return 50 here, not
		// 60 — this is the discriminating assertion the review flagged as
		// missing.
		assert.Len(t, got.Items, seeded)
	})

	t.Run("in-range limit is honoured exactly", func(t *testing.T) {
		got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-clamp-", Limit: 10})
		require.NoError(t, err)
		assert.Len(t, got.Items, 10)
	})
}
