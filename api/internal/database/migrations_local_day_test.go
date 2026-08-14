package database

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The backfill must reproduce the bucketing the OLD query-time logic produced,
// which is what makes SET NOT NULL safe on day one instead of a nullable
// column plus a fallback path maintained forever.
//
// The instant matters: at 12:00Z both Sydney (UTC+11) and Los Angeles (UTC-8)
// are still on 2026-03-01, so that time proves nothing. 02:00Z is 13:00 on the
// 1st in Sydney but 18:00 on the PREVIOUS day in LA, which is the case that
// actually distinguishes a profile-zone backfill from a UTC one. See kora#84.
func TestLocalDayBackfillUsesProfileTimezone(t *testing.T) {
	db := testDB(t)

	var sydney, la string
	require.NoError(t, db.Raw(`
		SELECT (TIMESTAMPTZ '2026-03-01 02:00:00Z' AT TIME ZONE 'Australia/Sydney')::date::text
	`).Scan(&sydney).Error)
	require.NoError(t, db.Raw(`
		SELECT (TIMESTAMPTZ '2026-03-01 02:00:00Z' AT TIME ZONE 'America/Los_Angeles')::date::text
	`).Scan(&la).Error)

	require.Equal(t, "2026-03-01", sydney)
	require.Equal(t, "2026-02-28", la, "a UTC backfill would give 2026-03-01 here")
}

func TestLocalDayColumnsExistAndAreNotNull(t *testing.T) {
	db := testDB(t)

	for _, table := range []string{"food_logs", "water_entries", "weight_entries"} {
		var isNullable string
		err := db.Raw(`
			SELECT is_nullable FROM information_schema.columns
			WHERE table_name = ? AND column_name = 'local_date'
		`, table).Scan(&isNullable).Error
		require.NoError(t, err, table)
		require.Equal(t, "NO", isNullable, "%s.local_date must exist and be NOT NULL", table)
	}

	var indexes int
	require.NoError(t, db.Raw(`
		SELECT count(*) FROM pg_indexes
		WHERE indexname IN (
			'idx_food_logs_user_local_date',
			'idx_water_entries_user_local_date',
			'idx_weight_entries_user_local_date'
		)
	`).Scan(&indexes).Error)
	require.Equal(t, 3, indexes)
}

// NOT NULL alone does not protect this column. Go's zero time.Time marshals
// to 0001-01-01, which Postgres accepts as a valid DATE — so a writer that
// forgets to set local_date would pass NOT NULL and store year 1, producing a
// row that matches no day query and is invisible forever. The CHECK turns that
// silent corruption into a failed write.
// Seeds its OWN user rather than selecting an arbitrary existing one. The
// first version did `INSERT ... SELECT id FROM users LIMIT 1`, which inserts
// ZERO rows on an empty database — so the statement succeeded, no constraint
// fired, and the test passed vacuously. It went green locally (where the dev
// database has users) and red on CI (where it does not), which is the wrong
// way round for a test whose entire job is to prove a constraint bites.
func TestLocalDayRejectsGoZeroTime(t *testing.T) {
	db := testDB(t)

	uid := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		uid, "localday-"+uid.String(), "localday@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", uid) })

	err := db.Exec(`
		INSERT INTO water_entries (user_id, logged_at, local_date, volume_ml)
		VALUES (?, now(), DATE '0001-01-01', 250)
	`, uid).Error
	require.Error(t, err, "a zero local_date must be rejected, not stored")
	require.Contains(t, err.Error(), "local_date_plausible")
}

// Every existing row must land in the bucket the old logic would have given
// it. Asserted against real rows rather than only against the SQL expression,
// because the migration's UPDATE joins users and could silently miss rows.
func TestLocalDayBackfillMatchesProfileZoneForExistingRows(t *testing.T) {
	db := testDB(t)

	// Skip rather than pass when there is nothing to check. On a fresh database
	// this query returns 0 mismatches out of 0 rows and reports success without
	// having verified anything — a green tick that means nothing is worse than
	// an honest skip.
	var rows int
	require.NoError(t, db.Raw(`SELECT count(*) FROM food_logs`).Scan(&rows).Error)
	if rows == 0 {
		t.Skip("no food_logs to verify the backfill against")
	}

	var mismatches int
	require.NoError(t, db.Raw(`
		SELECT count(*) FROM food_logs fl
		JOIN users u ON u.id = fl.user_id
		WHERE fl.local_date IS DISTINCT FROM (fl.logged_at AT TIME ZONE u.timezone)::date
	`).Scan(&mismatches).Error)
	require.Zero(t, mismatches, "backfilled local_date must match the profile-zone bucket")
}
