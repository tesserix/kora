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
