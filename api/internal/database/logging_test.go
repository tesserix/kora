package database

import (
	"bytes"
	"log"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/gorm/logger"
)

func TestConnectDoesNotLogSQLParameters(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	var output bytes.Buffer
	previous := logger.Default
	logger.Default = logger.New(log.New(&output, "", 0), logger.Config{LogLevel: logger.Warn})
	t.Cleanup(func() { logger.Default = previous })
	db, err := Connect(dsn)
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	err = db.Exec("SELECT ?::integer", "private-health-fixture").Error
	require.Error(t, err)
	require.NotContains(t, output.String(), "private-health-fixture")
}
