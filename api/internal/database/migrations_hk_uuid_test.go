package database

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// The index must be PARTIAL. Manual and screenshot weigh-ins carry no
// HealthKit UUID, so a plain unique index would let exactly one of them exist
// per user -- the second manual weigh-in would collide on NULL in any database
// that treats NULLs as equal, and the constraint would be silently wrong here
// the day the schema is ported.
func TestWeightEntriesHKUUIDIsUniqueOnlyWhenPresent(t *testing.T) {
	db := testDB(t)
	user := seedTrackingUser(t, db)

	hk := uuid.New()
	require.NoError(t, insertWeight(db, user, 70.0, &hk))
	require.Error(t, insertWeight(db, user, 71.0, &hk), "same hk_uuid must be rejected")

	require.NoError(t, insertWeight(db, user, 72.0, nil))
	require.NoError(t, insertWeight(db, user, 73.0, nil), "two NULL hk_uuids must coexist")
}

// seedTrackingUser inserts a fresh user, matching the style of the other
// migration tests in this package (e.g. TestLocalDayRejectsGoZeroTime): a
// user seeded per-test rather than selected from an arbitrary existing row,
// so the test behaves the same on an empty database as on a populated one.
func seedTrackingUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	uid := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		uid, "hkuuid-"+uid.String(), "hkuuid-"+uid.String()+"@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", uid) })
	return uid
}

func insertWeight(db *gorm.DB, userID uuid.UUID, kg float64, hk *uuid.UUID) error {
	return db.Exec(
		`INSERT INTO weight_entries (user_id, weight_kg, logged_at, local_date, source, hk_uuid)
		 VALUES (?, ?, now(), current_date, 'healthkit', ?)`,
		userID, kg, hk,
	).Error
}
