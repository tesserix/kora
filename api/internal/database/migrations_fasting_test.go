package database

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// kora#407. Declared fasting intervals must be separate from the inferred
// signal that caused kora#408: a stray food log incorrectly reported as a
// seven-day fast. See fasting_intervals_one_open below for the trap this
// test exists to catch.
func TestFastingIntervalsSchema(t *testing.T) {
	db := testDB(t)

	// Columns exist with the right nullability.
	for _, c := range []struct {
		name     string
		nullable string
	}{
		{"user_id", "NO"}, {"started_at", "NO"}, {"ended_at", "YES"},
		{"ended_by", "YES"}, {"local_date", "NO"},
	} {
		var nullable string
		require.NoError(t, db.Raw(
			`SELECT is_nullable FROM information_schema.columns
			 WHERE table_name='fasting_intervals' AND column_name=?`, c.name).
			Scan(&nullable).Error)
		require.Equal(t, c.nullable, nullable, "%s nullability", c.name)
	}

	// The index that enforces one open fast per user must be PARTIAL.
	// Postgres treats NULLs as distinct, so a non-partial unique index on
	// (user_id) would reject a SECOND CLOSED fast too — a bug that passes
	// any test which only ever inserts one row.
	var indexdef string
	require.NoError(t, db.Raw(
		`SELECT indexdef FROM pg_indexes
		 WHERE tablename='fasting_intervals' AND indexname='fasting_intervals_one_open'`).
		Scan(&indexdef).Error)
	require.Contains(t, indexdef, "WHERE (ended_at IS NULL)",
		"the unique index must be partial, or a user could never fast twice")
}
