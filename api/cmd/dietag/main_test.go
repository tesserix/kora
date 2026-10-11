package main

import (
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedUntagged inserts a row and then strips its tags, reproducing the rows
// written before migration 000043 — which the model hook would otherwise tag
// on the way in.
func seedUntagged(t *testing.T, db *gorm.DB, name string) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{
		Name: name + " " + uuid.NewString(), Provenance: nutrition.ProvenanceIFCT,
		Locale: nutrition.LocaleIN, KcalPer100g: 100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	require.NoError(t, db.Exec("UPDATE food_items SET diet_tags = '{}' WHERE id = ?", item.ID).Error)
	return item
}

func reload(t *testing.T, db *gorm.DB, id uuid.UUID) nutrition.FoodItem {
	t.Helper()
	var item nutrition.FoodItem
	require.NoError(t, db.Unscoped().First(&item, "id = ?", id).Error)
	return item
}

func TestRunTagsRowsWrittenBeforeTheTagColumnExisted(t *testing.T) {
	db := testDB(t)
	beef := seedUntagged(t, db, "Beef mince, lean")

	s, err := run(t.Context(), db, false)
	require.NoError(t, err)
	require.GreaterOrEqual(t, s.Tagged, 1)

	require.Contains(t, []string(reload(t, db, beef.ID).DietTags), "contains-beef")
}

func TestRunIsANoOpOnASecondPass(t *testing.T) {
	db := testDB(t)
	seedUntagged(t, db, "Paneer butter masala")

	_, err := run(t.Context(), db, false)
	require.NoError(t, err)
	second, err := run(t.Context(), db, false)
	require.NoError(t, err)

	require.Zero(t, second.Tagged, "a tagged index must not be rewritten every run")
	require.Equal(t, second.Scanned, second.Unchanged)
}

func TestRunDryRunWritesNothing(t *testing.T) {
	db := testDB(t)
	item := seedUntagged(t, db, "Prawn curry")

	s, err := run(t.Context(), db, true)
	require.NoError(t, err)

	require.GreaterOrEqual(t, s.Tagged, 1)
	require.NotEmpty(t, s.Samples, "a dry run must name what it would change")
	require.Empty(t, []string(reload(t, db, item.ID).DietTags))
}

func TestRunTagsARetiredRowSoRestoringItCannotBypassARule(t *testing.T) {
	db := testDB(t)
	item := seedUntagged(t, db, "Pork belly")
	require.NoError(t, db.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", item.ID).Error)

	_, err := run(t.Context(), db, false)
	require.NoError(t, err)

	require.Contains(t, []string(reload(t, db, item.ID).DietTags), "contains-pork")
}

func TestSameTagsIgnoresOrder(t *testing.T) {
	require.True(t, sameTags(pq.StringArray{"contains-egg", "contains-dairy"},
		[]string{"contains-dairy", "contains-egg"}))
	require.False(t, sameTags(pq.StringArray{"contains-egg"},
		[]string{"contains-egg", "contains-dairy"}))
}
