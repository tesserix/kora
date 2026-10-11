package database

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// kora#372. active_energy_kcal and resting_heart_rate_bpm join steps,
// sleep_minutes and workout_minutes on health_daily_summaries. Both must be
// nullable integers: a day synced without one of the two must not collapse
// the missing metric into a measured zero.
func TestHealthEnergyAndRestingHeartRateColumnsAreNullableIntegers(t *testing.T) {
	db := testDB(t)

	for _, col := range []string{"active_energy_kcal", "resting_heart_rate_bpm"} {
		t.Run(col, func(t *testing.T) {
			var row struct {
				DataType   string
				IsNullable string
			}
			require.NoError(t, db.Raw(`
				SELECT data_type, is_nullable FROM information_schema.columns
				WHERE table_name = 'health_daily_summaries' AND column_name = ?`, col).
				Scan(&row).Error)

			require.Equal(t, "integer", row.DataType, "%s must be an integer column", col)
			assert.Equal(t, "YES", row.IsNullable,
				"%s must be nullable: a day synced without this metric must stay absent, never 0", col)
		})
	}
}

// The resting heart rate CHECK constraint (20-250 bpm) is the guard against
// storing a value that could not belong to a human at rest.
func TestRestingHeartRateCheckConstraintRejectsOutOfRangeValues(t *testing.T) {
	db := testDB(t)

	var def string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'health_daily_summaries'::regclass AND contype = 'c'
		  AND conname = 'health_daily_summaries_resting_heart_rate_check'`).
		Scan(&def).Error)
	require.Contains(t, def, "20")
	require.Contains(t, def, "250")
}

// Active energy must be non-negative.
func TestActiveEnergyCheckConstraintRejectsNegativeValues(t *testing.T) {
	db := testDB(t)

	var def string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'health_daily_summaries'::regclass AND contype = 'c'
		  AND conname = 'health_daily_summaries_active_energy_check'`).
		Scan(&def).Error)
	require.Contains(t, def, ">= 0")
}

// health_energy_enabled and health_heart_rate_enabled follow the same
// opt-in-only pattern as the three flags added in 000040: NOT NULL, default
// FALSE.
func TestMentorProfileHealthConsentFlagsDefaultToOptedOut(t *testing.T) {
	db := testDB(t)

	for _, col := range []string{"health_energy_enabled", "health_heart_rate_enabled"} {
		t.Run(col, func(t *testing.T) {
			var row struct {
				DataType      string
				IsNullable    string
				ColumnDefault string
			}
			require.NoError(t, db.Raw(`
				SELECT data_type, is_nullable, column_default FROM information_schema.columns
				WHERE table_name = 'mentor_profiles' AND column_name = ?`, col).
				Scan(&row).Error)

			assert.Equal(t, "boolean", row.DataType, "%s must be boolean", col)
			assert.Equal(t, "NO", row.IsNullable, "%s must be NOT NULL, matching the existing consent flags", col)
			assert.Contains(t, row.ColumnDefault, "false", "%s must default to opted-out", col)
		})
	}
}

// A day carrying only active energy or only resting heart rate (no steps,
// sleep or workout) is a genuine HealthKit scenario and must be insertable
// -- the has_metric_check constraint was widened in 000051 to cover it.
func TestHasMetricCheckAllowsEnergyOrHeartRateAlone(t *testing.T) {
	db := testDB(t)

	var def string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'health_daily_summaries'::regclass AND contype = 'c'
		  AND conname = 'health_daily_summaries_has_metric_check'`).
		Scan(&def).Error)
	require.Contains(t, def, "active_energy_kcal")
	require.Contains(t, def, "resting_heart_rate_bpm")
}
