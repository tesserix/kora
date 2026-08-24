package database

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// kora#407. Declared fasting intervals must be separate from the inferred
// signal that caused kora#408: a stray food log incorrectly reported as a
// seven-day fast. See the fasting_intervals_one_open assertion below for the
// trap this test exists to catch.
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

	// fasting_intervals_one_open is GONE (migration 000053), and must stay
	// gone. It enforced "one row per user WHERE ended_at IS NULL", which was
	// the right invariant only while ended_at meant "this fast is over".
	// ended_at is written ONLY by an explicit end (decision 2), so a fast the
	// user ended by eating -- the ordinary case -- keeps ended_at NULL
	// forever. With the index in place, the user's NEXT genuine "start fast"
	// collided with a fast they had finished with days earlier and was never
	// recorded, which also kept its duration out of the eating-disorder risk
	// signal (kora#407). Openness is computed now; Postgres cannot express
	// it, and Start serialises concurrent starts with a per-user advisory
	// lock instead.
	//
	// Re-adding this index would silently reintroduce that bug, so this
	// asserts its absence rather than merely not asserting its presence.
	var indexes []string
	require.NoError(t, db.Raw(
		`SELECT indexname FROM pg_indexes WHERE tablename='fasting_intervals'`).
		Scan(&indexes).Error)
	require.NotContains(t, indexes, "fasting_intervals_one_open",
		"a partial unique index on the open fast blocks every fast after one ended by eating")
}
