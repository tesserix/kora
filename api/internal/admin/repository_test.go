package admin

import (
	"context"
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
	tx := seedTx(t, db, food("zzz-all-one", ""), food("zzz-all-two", ""))
	repo := NewRepository(tx)

	// Baseline must be discriminating: inside this transaction the unfiltered
	// total has to exceed the two rows we seeded, or "no filter" and "filter
	// matched everything" would be indistinguishable.
	got, err := repo.ListFoods(context.Background(), ListParams{Limit: 5})
	require.NoError(t, err)
	require.Greater(t, got.Total, int64(2), "shared table must hold more than the seeded rows for this to discriminate")
	assert.LessOrEqual(t, len(got.Items), 5, "limit must bound the page")
}
