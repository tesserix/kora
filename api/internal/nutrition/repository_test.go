package nutrition

import (
	"context"
	"database/sql"
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

// fixtureTx begins a transaction that is rolled back when the test ends, so
// every row a test inserts is discarded even when an assertion fails partway
// through. It is the isolation mechanism this package uses instead of
// TRUNCATE food_items (kora#151): the dev database is shared, a table-wide
// truncate destroys the food index that live AI resolves depend on, and it
// holds an ACCESS EXCLUSIVE lock for the life of the transaction — which
// stalls the other packages `go test ./...` runs concurrently against the
// same table.
//
// Rollback is best-effort on purpose: a test that already failed may have
// left the transaction aborted, and reporting that as a second failure would
// bury the real one.
func fixtureTx(t *testing.T) *gorm.DB {
	t.Helper()
	tx := testDB(t).Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func TestSeedIsIdempotentAndSearchable(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	// The old shape asserted a global insert count (n1 > 40), which only
	// holds against an empty table — so it truncated the shared food index
	// first (kora#151). Idempotency is a property of the SEED SET, not of the
	// table, and it is assertable without touching a row this test does not
	// own: run Seed twice, then check every curated item exists exactly once.
	// That holds whether the index arrives empty or already carries a
	// committed seed run, and it is strictly stronger than a count — a Seed
	// that inserted duplicates would still satisfy `n2 == 0` if it also
	// stopped counting them.
	items := SeedItems()
	require.Greater(t, len(items), 40, "precondition: the curated set is non-trivial")

	_, err := Seed(ctx, repo)
	require.NoError(t, err)

	n2, err := Seed(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, 0, n2, "a second Seed run must insert nothing")

	for _, want := range items {
		var n int64
		require.NoError(t, tx.Model(&FoodItem{}).
			Where("name = ? AND brand = ?", want.Name, want.Brand).
			Count(&n).Error)
		require.Equal(t, int64(1), n, "seed item %q must exist exactly once after two Seed runs", want.Name)
	}

	// Searchability is checked against a specific seeded row rather than the
	// bare word "chicken": Search is `name ILIKE %q% ... ORDER BY name ASC`
	// clamped to searchLimitMax, so against the real index the first 25 rows
	// matching "chicken" are whatever sorts alphabetically first, and none of
	// them need be a curated row.
	const seededName = "Grilled chicken breast"
	results, err := repo.Search(ctx, seededName, 10)
	require.NoError(t, err)
	var found bool
	for _, r := range results {
		if r.Name == seededName {
			found = true
			require.Contains(t, strings.ToLower(r.Name), "chicken")
		}
	}
	require.True(t, found, "a seeded curated row must be findable by its own name")
}

// TestGetByIDExcludesSoftDeleted seeds a live row and a soft-deleted row
// inside a rolled-back transaction and asserts GetByID resolves the live one
// while erroring (not found) on the retired one. Both halves are required: an
// assertion that only checks the retired row is unreachable would pass
// against a GetByID that returned an error for every id.
func TestGetByIDExcludesSoftDeleted(t *testing.T) {
	tx := fixtureTx(t)
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
//
// The delta is read under REPEATABLE READ, not the default READ COMMITTED
// (kora#151). Count() is table-wide and cannot be scoped by a WHERE clause,
// so under READ COMMITTED any row another package commits between the two
// Count() calls lands in the delta and fails this test for reasons that have
// nothing to do with soft deletion — observed as `expected: 18877, actual:
// 18878` while foodlog and pins ran alongside it. A repeatable-read snapshot
// makes the only difference between the two reads this transaction's own
// two inserts.
func TestCountExcludesSoftDeleted(t *testing.T) {
	db := testDB(t)
	tx := db.Begin(&sql.TxOptions{Isolation: sql.LevelRepeatableRead})
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
	tx := fixtureTx(t)
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
