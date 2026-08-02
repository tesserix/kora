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

// TestResolveDoesNotTruncateBeforeScoring guards against the SQL LIMIT being
// applied to the full-text candidate fetch before scoring happens in Go.
// Resolve's full-text query used to fetch only `limit` rows with no ORDER BY,
// so the rows handed to the scorer were an arbitrary subset of Postgres's scan
// order — the true best match could be silently excluded from scoring
// entirely just because it wasn't among the first `limit` rows physically
// scanned. This test inserts more full-text matches than the caller's limit,
// deliberately inserting the best match LAST (so an unordered, pre-scoring
// LIMIT would very likely drop it), and asserts Resolve still returns it as
// top-1: recall must fetch a generous, ordered pool for the ranker to
// consider, independent of how many results the caller asked for.
func TestResolveDoesNotTruncateBeforeScoring(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	// "zqxscanguard" is a unique token no ambient row contains. The first five
	// rows are weak matches (the token plus several unrelated words dilutes
	// both trigram similarity and precision); the sixth, inserted last, is an
	// exact match on the query and must win on score regardless of insertion
	// order.
	weakMatches := []string{
		"Zqxscanguard fried rice bowl mix",
		"Zqxscanguard grilled paneer tikka",
		"Zqxscanguard spicy chicken wrap",
		"Zqxscanguard baked salmon fillet",
		"Zqxscanguard roasted veggie medley",
	}
	items := make([]FoodItem, 0, len(weakMatches)+1)
	for _, n := range weakMatches {
		items = append(items, FoodItem{Name: n, Provenance: ProvenanceUSDA, KcalPer100g: 100})
	}
	items = append(items, FoodItem{Name: "Zqxscanguard", Provenance: ProvenanceUSDA, KcalPer100g: 100})
	_, err := repo.Insert(context.Background(), items)
	require.NoError(t, err)

	// Caller's limit (3) is smaller than the number of matching rows (6), and
	// smaller than the position of the best match in insertion order (6th).
	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxscanguard", nil, 3)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, "Zqxscanguard", cands[0].Item.Name,
		"the exact match must win top-1 even though it was inserted after limit weaker rows")
	require.Equal(t, MatchFullText, cands[0].MatchTier)
}

// TestResolveAliasKeepsExactScore guards the exemption: when two full-text
// candidates tie exactly (identical normalized_name, hence identical lexical
// scores), ambiguityFactor(0) returns 0.6, dragging all non-alias candidates
// down. Aliases must not be scaled by this factor—they remain 1.0 exact.
//
// The fixture uses two rows with identical Name but different Brand (so both
// insert), creating a genuine score tie. If the alias exemption is broken and
// aliases are scaled like full-text rows, this test fails with score ~0.6.
func TestResolveAliasKeepsExactScore(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Brekkie eggs", Brand: "brand_a", Provenance: ProvenanceCurated, KcalPer100g: 150},
		{Name: "Brekkie eggs", Brand: "brand_b", Provenance: ProvenanceCurated, KcalPer100g: 150},
		{Name: "Brekkie eggs", Brand: "brand_c", Provenance: ProvenanceCurated, KcalPer100g: 150},
	})
	require.NoError(t, err)

	var target FoodItem
	require.NoError(t, tx.First(&target, "name = ? AND brand = ?", "Brekkie eggs", "brand_a").Error)
	require.NoError(t, tx.Exec(
		`INSERT INTO food_aliases (user_id, alias, food_item_id) VALUES (NULL, ?, ?)`,
		"brekkie eggs", target.ID).Error)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "brekkie eggs", nil, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, MatchAlias, cands[0].MatchTier)
	require.InDelta(t, 1.0, cands[0].MatchScore, 0.0001)
}
