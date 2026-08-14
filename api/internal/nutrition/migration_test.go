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

// TestFoodItemsIndexesAreNonPartial guards the review-round-2 fix:
// idx_food_items_live (id) WHERE deleted_at IS NULL stays dropped as dead
// weight (see 000023_admin_mutations.up.sql for the measured evidence), but
// round 1's partial-index change on the other five indexes was REVERTED —
// migrations run as a sync-wave-0 Job ahead of the API rollout, so a partial
// index keyed on a predicate the OLD image's queries do not yet carry would
// lose every one of these indexes for the whole rollout window. This asserts
// both halves: the dead index is gone, and each real index carries NO
// deleted_at predicate, matching its pre-000023 definition exactly.
func TestFoodItemsIndexesAreNonPartial(t *testing.T) {
	db := testDB(t)

	var deadIndexCount int
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM pg_indexes WHERE tablename='food_items' AND indexname='idx_food_items_live'").
		Scan(&deadIndexCount).Error)
	require.Equal(t, 0, deadIndexCount, "idx_food_items_live must not exist — dropped as dead weight in migration 000023")

	nonPartialIndexes := []string{
		"idx_food_items_normalized_name",
		"idx_food_items_name_trgm",
		"idx_food_items_name",
		"idx_food_items_normalized_name_fts",
		"idx_food_items_embedding",
	}
	for _, name := range nonPartialIndexes {
		var indexdef string
		err := db.Raw(
			"SELECT indexdef FROM pg_indexes WHERE tablename='food_items' AND indexname=?", name).
			Scan(&indexdef).Error
		require.NoError(t, err)
		require.NotEmpty(t, indexdef, "index %s must exist", name)
		require.NotContains(t, indexdef, "WHERE",
			"index %s must NOT be partial: migrations run ahead of the API rollout that would add the deleted_at predicate to deployed queries (migration 000023, round 2)", name)
	}
}

// TestAdminEventsActorEmailCheckConstraint verifies all three cases of the
// actor_email CHECK: bffauth.Middleware guards UserID but not Email (round 1
// added the guard for empty; round 2 closed the middleware gap too, but this
// CHECK is the database-level backstop for any other write path into this
// table). round 2 changed the CHECK from a bare `<> ''` to
// `btrim(actor_email) <> ''`, so a whitespace-only value is rejected as well
// as the empty string — `<> ''` alone would have let "   " through.
func TestAdminEventsActorEmailCheckConstraint(t *testing.T) {
	db := testDB(t)

	insert := func(t *testing.T, email string) error {
		t.Helper()
		tx := db.Begin()
		require.NoError(t, tx.Error)
		t.Cleanup(func() { tx.Rollback() })
		return tx.Exec(
			"INSERT INTO kora_admin_events (actor_id, actor_email, action, target_type) VALUES (?, ?, ?, ?)",
			"user-1", email, "delete", "food_item").Error
	}

	require.Error(t, insert(t, ""), "empty actor_email must be rejected by the CHECK constraint")
	require.Error(t, insert(t, "   "), "whitespace-only actor_email must be rejected by the CHECK constraint")
	require.NoError(t, insert(t, "admin@example.com"), "non-empty actor_email must be accepted")
}
