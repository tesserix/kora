package database

import (
	"os"
	"strings"
	"testing"

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

func countContaining(values []string, needle string) int {
	count := 0
	for _, value := range values {
		if strings.Contains(value, needle) {
			count++
		}
	}
	return count
}
