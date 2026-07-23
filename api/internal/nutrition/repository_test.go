package nutrition

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
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

func TestSeedIsIdempotentAndSearchable(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE provenance IN ('afcd','off','user_estimate')") })

	n1, err := Seed(context.Background(), repo)
	require.NoError(t, err)
	require.Greater(t, n1, 40)

	// Second run inserts nothing new.
	n2, err := Seed(context.Background(), repo)
	require.NoError(t, err)
	require.Equal(t, 0, n2)

	results, err := repo.Search(context.Background(), "chicken", 10)
	require.NoError(t, err)
	require.NotEmpty(t, results)
	require.Contains(t, strings.ToLower(results[0].Name), "chicken")
}

func TestInsertDedupsOnBarcode(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	bc := "999" + uuid.NewString()[:9]
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", bc) })

	first := []FoodItem{{Name: "Barcode A", Provenance: ProvenanceOFF, Barcode: &bc, KcalPer100g: 100}}
	n1, err := repo.Insert(context.Background(), first)
	require.NoError(t, err)
	require.Equal(t, 1, n1)

	// Different name, SAME barcode → must be skipped (would violate the unique index).
	second := []FoodItem{{Name: "Barcode A Renamed", Provenance: ProvenanceOFF, Barcode: &bc, KcalPer100g: 100}}
	n2, err := repo.Insert(context.Background(), second)
	require.NoError(t, err)
	require.Equal(t, 0, n2)
}
