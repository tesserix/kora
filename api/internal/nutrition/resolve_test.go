package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func seedFor(t *testing.T, repo Repository, items []FoodItem) {
	t.Helper()
	_, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)
}

func TestResolveAliasBeatsFullText(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })
	t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE alias = 'brekkie eggs'") })

	seedFor(t, repo, []FoodItem{
		{Name: "Scrambled eggs", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 150},
		{Name: "Egg noodles", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 130},
	})
	// alias points "brekkie eggs" -> scrambled eggs
	var scrambled FoodItem
	require.NoError(t, db.First(&scrambled, "name = ? AND brand = 'test2a'", "Scrambled eggs").Error)
	db.Exec("INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", "brekkie eggs", scrambled.ID)

	got, err := repo.Resolve(context.Background(), "brekkie eggs", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, MatchAlias, got[0].MatchTier)
	require.Equal(t, scrambled.ID, got[0].Item.ID)
	require.InDelta(t, 1.0, got[0].MatchScore, 0.001)
}

func TestResolveFullTextRanksByName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })

	// "zqxnonce" is a unique token no ambient row (seed data or ingested
	// AFCD/USDA foods) contains, so this test is deterministic regardless of
	// what else lives in the DB. plainto_tsquery matches both rows via the
	// nonce, but the grilled-chicken row matches 2 lexemes (zqxnonce +
	// chicken) vs 1 for the water row, so ts_rank ranks it first.
	seedFor(t, repo, []FoodItem{
		{Name: "Zqxnonce grilled chicken", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
		{Name: "Zqxnonce plain water", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 0},
	})
	got, err := repo.Resolve(context.Background(), "zqxnonce chicken", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, "Zqxnonce grilled chicken", got[0].Item.Name)
	require.Equal(t, MatchFullText, got[0].MatchTier)
}

func TestResolveFullTextMatchesPluralQueryAgainstSingularizedName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })

	// Insert normalizes "Rolled oats, raw" -> normalized_name "rolled oat".
	// Querying the plural "oats" normalizes to "oat" on the query side too,
	// so tier-2 full-text must compare against normalized_name (not the
	// verbatim, un-singularized fi.name) for the two sides to match.
	seedFor(t, repo, []FoodItem{
		{Name: "Rolled oats, raw", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 379},
	})

	got, err := repo.Resolve(context.Background(), "oats", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)

	var found *Candidate
	for i := range got {
		if got[i].Item.Brand == "test2a" {
			found = &got[i]
			break
		}
	}
	require.NotNil(t, found, "expected the seeded oats row to be resolved")
	require.Equal(t, MatchFullText, found.MatchTier)
}

func TestInsertSetsNormalizedName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })
	seedFor(t, repo, []FoodItem{{Name: "Rolled Oats", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 380}})
	var it FoodItem
	require.NoError(t, db.First(&it, "name = 'Rolled Oats' AND brand = 'test2a'").Error)
	require.Equal(t, "rolled oat", it.NormalizedName)
}
