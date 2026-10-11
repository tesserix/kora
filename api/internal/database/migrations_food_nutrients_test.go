package database

import (
	"os"
	"testing"

	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/stretchr/testify/require"
)

func TestMigrationSourceHasNoDuplicateVersions(t *testing.T) {
	src, err := iofs.New(migrationsFS, "migrations")
	require.NoError(t, err)
	require.NoError(t, src.Close())
}

func TestFoodNutrientsUpgradeFromDeployedVersion62(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	require.NoError(t, Migrate(url))
	m := testMigrator(t, url)
	require.NoError(t, m.Migrate(62))
	t.Cleanup(func() { require.NoError(t, Migrate(url)) })
	db := testDB(t)
	var columns int64
	query := `SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'food_items' AND column_name = 'sodium_mg_per_100g'`
	require.NoError(t, db.Raw(query).Scan(&columns).Error)
	require.Zero(t, columns)
	require.NoError(t, Migrate(url))
	require.NoError(t, db.Raw(query).Scan(&columns).Error)
	require.EqualValues(t, 1, columns)
}
