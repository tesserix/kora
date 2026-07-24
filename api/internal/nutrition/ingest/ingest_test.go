package ingest

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// TestRunIsDeterministicForOverlappingFoods proves that when the same food
// (matched by name+brand) appears in more than one input file, Run always
// picks the alphabetically-first file's row, regardless of Go's randomized
// map iteration order.
func TestRunIsDeterministicForOverlappingFoods(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'zdup'") })

	files := map[string]string{
		"testdata/dedup_a.json": nutrition.ProvenanceAFCD,
		"testdata/dedup_b.json": nutrition.ProvenanceUSDA,
	}

	_, err := Run(context.Background(), repo, files)
	require.NoError(t, err)

	var item nutrition.FoodItem
	require.NoError(t, db.First(&item, "name = 'Zdup' AND brand = 'zdup'").Error)
	require.Equal(t, float64(100), item.KcalPer100g)
}
