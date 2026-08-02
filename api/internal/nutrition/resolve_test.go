package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
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

	got, err := repo.Resolve(context.Background(), uuid.Nil, "brekkie eggs", nil, 5)
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
	got, err := repo.Resolve(context.Background(), uuid.Nil, "zqxnonce chicken", nil, 5)
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

	got, err := repo.Resolve(context.Background(), uuid.Nil, "oats", nil, 5)
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

// TestResolveBreaksTiesThatTsRankCannot is the regression guard for the bug
// this whole change exists to fix. Every one of these rows has an IDENTICAL
// ts_rank (0.09910 for a two-term query); if match_score is ever again a
// function of ts_rank alone, these assertions fail.
func TestResolveBreaksTiesThatTsRankCannot(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	names := []string{
		"Chicken breast",
		"Chicken breast roasted",
		"Grilled chicken breast",
		"Fast foods fried chicken breast",
		"Fast foods fried chicken breast wing thigh drumstick nugget",
	}
	items := make([]FoodItem, 0, len(names))
	for _, n := range names {
		items = append(items, FoodItem{Name: n, Provenance: ProvenanceUSDA, KcalPer100g: 165})
	}
	_, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "chicken breast", nil, 10)
	require.NoError(t, err)
	require.Len(t, cands, 5)

	// The exact row wins, not an arbitrary tied one.
	require.Equal(t, "Chicken breast", cands[0].Item.Name)

	// Scores are strictly descending — i.e. they actually discriminate.
	for i := 1; i < len(cands); i++ {
		require.Less(t, cands[i].MatchScore, cands[i-1].MatchScore,
			"candidate %d (%q) must score below %d (%q)",
			i, cands[i].Item.Name, i-1, cands[i-1].Item.Name)
	}

	// The specific prod failure: the clinical near-duplicate must lose.
	require.Greater(t, cands[0].MatchScore, cands[len(cands)-1].MatchScore)
	require.Contains(t, cands[len(cands)-1].Item.Name, "wing thigh drumstick")
}

// TestResolveScoreIsNotFloored proves the 0.7 clamp is gone. Under the old
// formula every full-text candidate was structurally >= 0.70 and follow_up was
// unreachable.
func TestResolveScoreIsNotFloored(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	// Two near-identical variants and no exact row — the real prod shape for
	// "chicken breast".
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Chicken breast roasted", Provenance: ProvenanceUSDA, KcalPer100g: 165},
		{Name: "Grilled chicken breast", Provenance: ProvenanceUSDA, KcalPer100g: 165},
	})
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "chicken breast", nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Less(t, cands[0].MatchScore, 0.70,
		"near-tied candidates must be able to score below the confirm floor")
}

// TestResolveAliasKeepsExactScore guards the exemption: an alias is exact
// intent and must not be dragged down by an equally-scored full-text row.
func TestResolveAliasKeepsExactScore(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Brekkie eggs", Provenance: ProvenanceCurated, KcalPer100g: 150},
		{Name: "Brekkie eggs deluxe", Provenance: ProvenanceCurated, KcalPer100g: 150},
	})
	require.NoError(t, err)

	var target FoodItem
	require.NoError(t, tx.First(&target, "name = ?", "Brekkie eggs").Error)
	require.NoError(t, tx.Exec(
		`INSERT INTO food_aliases (user_id, alias, food_item_id) VALUES (NULL, ?, ?)`,
		"brekkie eggs", target.ID).Error)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "brekkie eggs", nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, MatchAlias, cands[0].MatchTier)
	require.InDelta(t, 1.0, cands[0].MatchScore, 0.0001)
}
