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
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })

	// Seed's insert-count assertions require an empty table, but this suite
	// must not destroy a pre-populated shared food_items. Truncate inside
	// the transaction: the truncate and every subsequent insert are
	// transactional and get discarded on rollback, so committed rows
	// outside this tx are never touched.
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

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

// TestGetByIDExcludesSoftDeleted seeds a live row and a soft-deleted row
// inside a rolled-back transaction and asserts GetByID resolves the live one
// while erroring (not found) on the retired one. Both halves are required: an
// assertion that only checks the retired row is unreachable would pass
// against a GetByID that returned an error for every id.
func TestGetByIDExcludesSoftDeleted(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	live := FoodItem{Name: "Live GetByID Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&live).Error)
	retired := FoodItem{Name: "Retired GetByID Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	got, err := repo.GetByID(context.Background(), live.ID)
	require.NoError(t, err, "the live row must still resolve by id")
	require.Equal(t, live.ID, got.ID)

	_, err = repo.GetByID(context.Background(), retired.ID)
	require.Error(t, err, "a retired row must not resolve by id")
}

// TestCountExcludesSoftDeleted proves the index-size gauge does not count
// retired rows. Uses a before/after DELTA rather than TRUNCATE food_items
// CASCADE (the shape this test used before this fix): a table-wide TRUNCATE
// takes an ACCESS EXCLUSIVE lock held until this transaction rolls back, and
// `go test ./...` runs packages concurrently — admin, metrics, savedmeals,
// pins and foodlog all read food_items too, so that lock can stall or
// deadlock against them. The same assertion is reachable without it: read
// Count() before seeding, add one live and one retired row, and check the
// count moved by exactly 1 — the live row only.
func TestCountExcludesSoftDeleted(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	before, err := repo.Count(context.Background())
	require.NoError(t, err)

	live := FoodItem{Name: "Live Count Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&live).Error)
	retired := FoodItem{Name: "Retired Count Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	after, err := repo.Count(context.Background())
	require.NoError(t, err)
	require.Equal(t, before+1, after, "count must move by exactly 1 for the live row; the retired row must not be counted")
}

// TestSearchExcludesSoftDeleted covers the mobile picker: a retired food must
// not be a candidate a user can log.
func TestSearchExcludesSoftDeleted(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	unique := uuid.NewString()
	live := FoodItem{Name: "Zzsearch Live " + unique, Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&live).Error)
	retired := FoodItem{Name: "Zzsearch Retired " + unique, Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	got, err := repo.Search(context.Background(), "Zzsearch", 10)
	require.NoError(t, err)

	var ids []uuid.UUID
	for _, it := range got {
		ids = append(ids, it.ID)
	}
	require.Contains(t, ids, live.ID, "the live row must still be searchable")
	require.NotContains(t, ids, retired.ID, "a retired row must not be searchable")
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
