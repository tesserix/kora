package database

import (
	"os"
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
