package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVectorExtensionAndColumns(t *testing.T) {
	db := testDB(t) // skips if Postgres unavailable
	var ext int
	require.NoError(t, db.Raw("SELECT count(*) FROM pg_extension WHERE extname = 'vector'").Scan(&ext).Error)
	require.Equal(t, 1, ext, "vector extension must be installed (run migrations against pgvector/pgvector:pg15)")

	var cols int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM information_schema.columns WHERE table_name='food_items' AND column_name IN ('embedding','normalized_name')").
		Scan(&cols).Error)
	require.Equal(t, 2, cols)
}

func TestTrigramExtensionAvailable(t *testing.T) {
	db := testDB(t)
	var sim float64
	err := db.Raw(`SELECT similarity('chicken breast', 'chicken breast')`).Scan(&sim).Error
	require.NoError(t, err)
	require.InDelta(t, 1.0, sim, 0.001)

	// The discriminating property: a longer, noisier name must score lower
	// than an exact one. This is precisely what ts_rank could not do.
	var exact, noisy float64
	require.NoError(t, db.Raw(`SELECT similarity('chicken breast', 'chicken breast')`).Scan(&exact).Error)
	require.NoError(t, db.Raw(`SELECT similarity('fast food fried chicken breast wing thigh drumstick nugget', 'chicken breast')`).Scan(&noisy).Error)
	require.Greater(t, exact, noisy)
}

func TestAdminMutationsColumnsAndTable(t *testing.T) {
	db := testDB(t)
	var cols int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM information_schema.columns WHERE table_name='food_items' AND column_name IN ('deleted_at','updated_at')").
		Scan(&cols).Error)
	require.Equal(t, 2, cols, "food_items must have deleted_at and updated_at (migration 000023)")

	var tables int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM information_schema.tables WHERE table_name='kora_admin_events'").
		Scan(&tables).Error)
	require.Equal(t, 1, tables, "kora_admin_events must exist (migration 000023)")
}

// TestFoodItemsIndexesArePartialOnDeletedAt guards the review-round-1 fix:
// idx_food_items_live (id) WHERE deleted_at IS NULL was dropped as dead
// weight (see 000023_admin_mutations.up.sql for the measured evidence), and
// the five indexes the read paths actually filter on were made partial
// instead. This asserts both halves: the dead index is gone, and each real
// index carries the predicate.
func TestFoodItemsIndexesArePartialOnDeletedAt(t *testing.T) {
	db := testDB(t)

	var deadIndexCount int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM pg_indexes WHERE tablename='food_items' AND indexname='idx_food_items_live'").
		Scan(&deadIndexCount).Error)
	require.Equal(t, 0, deadIndexCount, "idx_food_items_live must not exist — dropped as dead weight in migration 000023")

	partialIndexes := []string{
		"idx_food_items_normalized_name",
		"idx_food_items_name_trgm",
		"idx_food_items_name",
		"idx_food_items_normalized_name_fts",
		"idx_food_items_embedding",
	}
	for _, name := range partialIndexes {
		var indexdef string
		err := db.Raw(
			"SELECT indexdef FROM pg_indexes WHERE tablename='food_items' AND indexname=?", name).
			Scan(&indexdef).Error
		require.NoError(t, err)
		require.NotEmpty(t, indexdef, "index %s must exist", name)
		require.Contains(t, indexdef, "WHERE (deleted_at IS NULL)",
			"index %s must be partial on deleted_at IS NULL (migration 000023)", name)
	}
}

// TestAdminEventsActorEmailCheckConstraint verifies both halves of the
// actor_email CHECK added in review round 1: bffauth.Middleware guards
// UserID but not Email, so NOT NULL alone would let a correctly-signed
// request with an empty X-User-Email store an unattributed audit row. The
// CHECK must reject an empty string and accept a real one.
func TestAdminEventsActorEmailCheckConstraint(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })

	err := tx.Exec(
		"INSERT INTO kora_admin_events (actor_id, actor_email, action, target_type) VALUES (?, ?, ?, ?)",
		"user-1", "", "delete", "food_item").Error
	require.Error(t, err, "empty actor_email must be rejected by the CHECK constraint")

	// The failed insert above aborts the transaction; start a fresh one for
	// the accept-half of the assertion.
	tx2 := db.Begin()
	require.NoError(t, tx2.Error)
	t.Cleanup(func() { tx2.Rollback() })

	err = tx2.Exec(
		"INSERT INTO kora_admin_events (actor_id, actor_email, action, target_type) VALUES (?, ?, ?, ?)",
		"user-1", "admin@example.com", "delete", "food_item").Error
	require.NoError(t, err, "non-empty actor_email must be accepted")
}
