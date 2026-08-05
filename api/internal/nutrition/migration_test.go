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
