package database

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

func TestAIUsageEventsSurvivesUserDeletion(t *testing.T) {
	db := testDB(t)

	var isNullable string
	require.NoError(t, db.Raw(`
		SELECT is_nullable FROM information_schema.columns
		WHERE table_name = 'ai_usage_events' AND column_name = 'user_id'`).
		Scan(&isNullable).Error)
	assert.Equal(t, "YES", isNullable, "user_id must be nullable to survive its user")

	var def string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conrelid = 'ai_usage_events'::regclass AND contype = 'f'`).
		Scan(&def).Error)
	assert.Contains(t, def, "ON DELETE SET NULL")
	assert.NotContains(t, def, "ON DELETE CASCADE")
}

func TestAIQuotaWindowsSchemaEnforcesFixedWindowIdentity(t *testing.T) {
	db := testDB(t)

	var tableName string
	require.NoError(t, db.Raw(`SELECT to_regclass('public.ai_quota_windows')::text`).Scan(&tableName).Error)
	require.Equal(t, "ai_quota_windows", tableName)

	var primaryKey string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'ai_quota_windows'::regclass AND contype = 'p'`).Scan(&primaryKey).Error)
	require.Contains(t, primaryKey, "user_id, window_kind, window_start")

	var kindCheck string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'ai_quota_windows'::regclass AND contype = 'c'
		  AND conname = 'ai_quota_windows_kind_check'`).Scan(&kindCheck).Error)
	require.Contains(t, kindCheck, "day")
	require.Contains(t, kindCheck, "week")
	require.Contains(t, kindCheck, "month")
}

// kora#45. weight_entries carries body composition beyond a bare weight, and
// two properties of that schema are load-bearing enough to assert:
//
//   - every metric is NULLABLE, because absent must not collapse into a
//     measured zero once a chart plots it;
//   - `source` is NOT NULL with a CHECK, because the same-named metric is not
//     comparable across instruments and a row without provenance cannot be
//     safely joined into a trend.
func TestWeightEntriesBodyCompositionColumns(t *testing.T) {
	db := testDB(t)

	type column struct {
		DataType   string
		IsNullable string
	}
	nullableMetrics := []string{
		"body_fat_pct",
		"subcutaneous_fat_pct",
		"visceral_fat_rating",
		"skeletal_muscle_pct",
		"muscle_mass_kg",
		"body_water_pct",
		"protein_pct",
		"bone_mass_kg",
		"scale_bmr_kcal",
	}
	for _, name := range nullableMetrics {
		var got column
		require.NoError(t, db.Raw(`
			SELECT data_type, is_nullable FROM information_schema.columns
			WHERE table_name = 'weight_entries' AND column_name = ?`, name).
			Scan(&got).Error)
		assert.Equal(t, "double precision", got.DataType, "%s must be double precision", name)
		assert.Equal(t, "YES", got.IsNullable, "%s must be nullable: absent is not zero", name)
	}

	// visceral_fat_rating is a vendor RATING, not a percentage — Renpho shows a
	// bare 7, Omron 7.5 level, Tanita a 1-59 scale. The name must not end in
	// _pct, or every reader downstream will render it with a % sign.
	var pctNamed int
	require.NoError(t, db.Raw(`
		SELECT COUNT(*) FROM information_schema.columns
		WHERE table_name = 'weight_entries' AND column_name = 'visceral_fat_pct'`).
		Scan(&pctNamed).Error)
	assert.Zero(t, pctNamed, "visceral fat is a rating, not a percentage")

	var source column
	require.NoError(t, db.Raw(`
		SELECT data_type, is_nullable FROM information_schema.columns
		WHERE table_name = 'weight_entries' AND column_name = 'source'`).
		Scan(&source).Error)
	assert.Equal(t, "text", source.DataType)
	assert.Equal(t, "NO", source.IsNullable, "source must be NOT NULL")

	var sourceDefault string
	require.NoError(t, db.Raw(`
		SELECT column_default FROM information_schema.columns
		WHERE table_name = 'weight_entries' AND column_name = 'source'`).
		Scan(&sourceDefault).Error)
	assert.Contains(t, sourceDefault, "manual", "existing rows were typed by hand")

	var sourceCheck string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'weight_entries'::regclass AND contype = 'c'
		  AND conname = 'weight_entries_source_check'`).Scan(&sourceCheck).Error)
	for _, allowed := range []string{"manual", "scale_screenshot", "inbody", "dexa", "healthkit"} {
		require.Contains(t, sourceCheck, allowed)
	}
}

// The derived values are absent by design — storing one alongside its inputs
// lets a single row contradict itself, with nothing to say which field to
// believe. This test is what makes that a decision rather than an oversight, so
// re-adding any of them has to be deliberate. See migration 000039.
func TestWeightEntriesDoesNotStoreDerivedValues(t *testing.T) {
	db := testDB(t)

	for _, name := range []string{"bmi", "fat_free_mass_kg", "fat_mass_kg", "metabolic_age", "bmr_kcal"} {
		var count int
		require.NoError(t, db.Raw(`
			SELECT COUNT(*) FROM information_schema.columns
			WHERE table_name = 'weight_entries' AND column_name = ?`, name).
			Scan(&count).Error)
		assert.Zero(t, count, "%s is derived or vendor-invented and must not be stored", name)
	}
}

func TestPersonalMentorSchemaOwnsUserDataAndRetryIdentity(t *testing.T) {
	db := testDB(t)

	for _, table := range []string{
		"mentor_profiles",
		"health_daily_summaries",
		"mentor_commitments",
		"mentor_check_ins",
		"mentor_commitment_proposals",
	} {
		var name string
		require.NoError(t, db.Raw(`SELECT to_regclass(?)::text`, "public."+table).Scan(&name).Error)
		require.Equal(t, table, name)
	}

	var healthPrimaryKey string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'health_daily_summaries'::regclass AND contype = 'p'`).
		Scan(&healthPrimaryKey).Error)
	require.Contains(t, healthPrimaryKey, "user_id, local_date")

	var checkInIdentity string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'mentor_check_ins'::regclass
		  AND conname = 'mentor_check_ins_occurrence_unique'`).
		Scan(&checkInIdentity).Error)
	require.Contains(t, checkInIdentity, "commitment_id, scheduled_for")

	for _, table := range []string{
		"mentor_profiles",
		"health_daily_summaries",
		"mentor_commitments",
		"mentor_check_ins",
	} {
		var definitions []string
		require.NoError(t, db.Raw(`
			SELECT pg_get_constraintdef(oid)
			FROM pg_constraint
			WHERE conrelid = ?::regclass AND contype = 'f'`, table).
			Scan(&definitions).Error)
		require.NotEmpty(t, definitions, "%s must be owned through a foreign key", table)
		for _, definition := range definitions {
			require.Contains(t, definition, "ON DELETE CASCADE", "%s must not outlive its owner", table)
		}
	}

	var proposalForeignKeys []string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'mentor_commitment_proposals'::regclass AND contype = 'f'`).
		Scan(&proposalForeignKeys).Error)
	require.Len(t, proposalForeignKeys, 3)
	require.Equal(t, 2, countContaining(proposalForeignKeys, "ON DELETE CASCADE"))
	require.Equal(t, 1, countContaining(proposalForeignKeys, "ON DELETE SET NULL"))

	var proposalTurnIdentity string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'mentor_commitment_proposals'::regclass
		  AND contype = 'u' AND pg_get_constraintdef(oid) LIKE '%coach_turn_id%'`).
		Scan(&proposalTurnIdentity).Error)
	require.Contains(t, proposalTurnIdentity, "coach_turn_id")
}

// testMigrator opens a fresh golang-migrate instance against url so a test
// can step a single migration up/down without going through cmd/migrate
// (which only ever applies everything pending).
func testMigrator(t *testing.T, url string) *migrate.Migrate {
	t.Helper()
	src, err := iofs.New(migrationsFS, "migrations")
	require.NoError(t, err)
	m, err := migrate.NewWithSourceInstance("iofs", src, url)
	require.NoError(t, err)
	return m
}

// TestDropShareProgressBackfillsCirclesFromFriendships proves the semantics
// of migration 000055, not just that it runs (kora#326).
//
// It always brings the schema to the LATEST migration first, then steps
// 000055 down (restoring users.share_progress) and back up again, so the
// assertions hold whether or not 000055 had already been applied when the
// suite started -- there is no way to seed a share_progress value on a
// schema that has already dropped the column.
//
// share_progress = true must become exactly one "Friends" circle holding
// only the ACCEPTED friends (never a pending request) with a `progress`
// grant. share_progress = false must produce no circle at all -- the same
// deny-by-default the boolean used to encode.
func TestDropShareProgressBackfillsCirclesFromFriendships(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db := testDB(t)

	require.NoError(t, Migrate(url), "bring schema to latest before stepping 000055 down")

	m := testMigrator(t, url)
	// Migrate to the explicit pre-000055 version, not "one step below
	// latest": later migrations (e.g. 000056) get appended after this test
	// was written, and Steps(-1) from an unknown latest would undo whichever
	// migration happens to be newest instead of 000055 specifically.
	require.NoError(t, m.Migrate(54), "migrate to 000054 to restore users.share_progress")
	t.Cleanup(func() {
		// Leave the schema at latest for every other test in this (and
		// later) run, regardless of how this test exits.
		require.NoError(t, Migrate(url))
	})

	sharer := uuid.New()
	nonSharer := uuid.New()
	nonSharerFriend := uuid.New()
	acceptedA := uuid.New()
	acceptedB := uuid.New()
	pending := uuid.New()
	seededUsers := []uuid.UUID{sharer, nonSharer, nonSharerFriend, acceptedA, acceptedB, pending}

	for _, id := range seededUsers {
		require.NoError(t, db.Exec(
			`INSERT INTO users (id, firebase_uid, email, share_progress) VALUES (?, ?, ?, false)`,
			id, "backfill-"+id.String(), id.String()+"@test.dev").Error)
	}
	t.Cleanup(func() {
		for _, id := range seededUsers {
			db.Exec(`DELETE FROM users WHERE id = ?`, id)
		}
	})
	require.NoError(t, db.Exec(`UPDATE users SET share_progress = true WHERE id = ?`, sharer).Error)

	// nonSharer already owns their OWN circle named "Friends", curated by hand
	// (Task 6 lets any user create one, and it can pre-date this migration).
	// It starts empty. The migration must never touch it: nonSharer's
	// share_progress was false, so this circle is not one it created and
	// matching on name alone would silently widen sharing nonSharer never
	// consented to.
	preExistingCircleID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)`,
		preExistingCircleID, nonSharer, "Friends").Error)
	t.Cleanup(func() {
		db.Exec(`DELETE FROM share_circles WHERE id = ?`, preExistingCircleID)
	})

	for _, f := range []struct {
		requester, addressee uuid.UUID
		status               string
	}{
		{sharer, acceptedA, "accepted"},
		{acceptedB, sharer, "accepted"}, // direction must not matter
		{sharer, pending, "pending"},
		// nonSharer has an accepted friend too, so the mutation check below
		// actually exercises the bug this test guards against: without the
		// scoping fix, this friend would land in nonSharer's PRE-EXISTING
		// "Friends" circle even though share_progress was false.
		{nonSharer, nonSharerFriend, "accepted"},
	} {
		require.NoError(t, db.Exec(
			`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)`,
			f.requester, f.addressee, f.status).Error)
	}
	t.Cleanup(func() {
		db.Exec(`DELETE FROM friendships WHERE requester_id IN ? OR addressee_id IN ?`, seededUsers, seededUsers)
	})

	require.NoError(t, m.Steps(1), "step 000055 up: run the backfill and drop the column")

	var hasColumn int
	require.NoError(t, db.Raw(`
		SELECT COUNT(*) FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'share_progress'`).Scan(&hasColumn).Error)
	require.Zero(t, hasColumn, "share_progress must be dropped")

	var circleIDs []uuid.UUID
	require.NoError(t, db.Raw(`SELECT id FROM share_circles WHERE owner_id = ?`, sharer).Scan(&circleIDs).Error)
	require.Len(t, circleIDs, 1, "exactly one circle for the sharer")

	var circleName string
	require.NoError(t, db.Raw(`SELECT name FROM share_circles WHERE id = ?`, circleIDs[0]).Scan(&circleName).Error)
	require.Equal(t, "Friends", circleName)

	var members []uuid.UUID
	require.NoError(t, db.Raw(`SELECT member_user_id FROM share_circle_members WHERE circle_id = ? ORDER BY member_user_id`, circleIDs[0]).
		Scan(&members).Error)
	require.ElementsMatch(t, []uuid.UUID{acceptedA, acceptedB}, members, "only accepted friends, never the pending one")

	var grantCount int
	require.NoError(t, db.Raw(`SELECT COUNT(*) FROM share_grants WHERE circle_id = ? AND category = 'progress'`, circleIDs[0]).
		Scan(&grantCount).Error)
	require.Equal(t, 1, grantCount)

	var nonSharerCircles int
	require.NoError(t, db.Raw(`SELECT COUNT(*) FROM share_circles WHERE owner_id = ?`, nonSharer).Scan(&nonSharerCircles).Error)
	require.Equal(t, 1, nonSharerCircles, "the pre-existing circle must still be the only one -- no new circle was created")

	// The one fragile property under review: the backfill must correlate to
	// the circles IT created (via users.share_progress = true), never to a
	// circle name alone. A user's own pre-existing "Friends" circle must come
	// out exactly as it went in.
	var preExistingMembers int
	require.NoError(t, db.Raw(`SELECT COUNT(*) FROM share_circle_members WHERE circle_id = ?`, preExistingCircleID).
		Scan(&preExistingMembers).Error)
	require.Zero(t, preExistingMembers, "migration must not add members to a circle it did not create")

	var preExistingGrants int
	require.NoError(t, db.Raw(`SELECT COUNT(*) FROM share_grants WHERE circle_id = ?`, preExistingCircleID).
		Scan(&preExistingGrants).Error)
	require.Zero(t, preExistingGrants, "migration must not grant a category on a circle it did not create")

	fmt.Printf("backfill test: sharer circle=%d members=%d grants=%d nonSharerCircles=%d preExistingMembers=%d preExistingGrants=%d\n",
		len(circleIDs), len(members), grantCount, nonSharerCircles, preExistingMembers, preExistingGrants)
}

func countContaining(values []string, needle string) int {
	count := 0
	for _, value := range values {
		if strings.Contains(value, needle) {
			count++
		}
	}
	return count
}
