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
	// what else lives in the DB. Both rows contain BOTH query lexemes
	// ("zqxnonce" and "chicken"), so plainto_tsquery's AND predicate matches
	// both — verified via `to_tsvector('simple', ...) @@ plainto_tsquery('simple',
	// 'zqxnonce chicken')` for the diluted row too — so this is a genuine
	// two-candidate ranking, unlike the old fixture where the second row
	// (which shared no token with "chicken") never matched the predicate at
	// all and the ranking assertion could never fail.
	//
	// Scoring is now coverage/precision/trigram, not ts_rank (see score.go
	// quality()): the exact-match row has coverage=precision=trigram=1.0, the
	// ceiling. The diluted row shares the same two query tokens but adds four
	// more (precision=2/6=0.333) and has lower trigram similarity to the
	// query (0.386, verified via psql) since its token set is a strict
	// superset — so it scores strictly lower under any coverage/precision
	// weighting where extra tokens are not free.
	seedFor(t, repo, []FoodItem{
		{Name: "Zqxnonce chicken", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
		{Name: "Zqxnonce chicken nugget wing thigh drumstick", Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
	})
	got, err := repo.Resolve(context.Background(), uuid.Nil, "zqxnonce chicken", nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, "Zqxnonce chicken", got[0].Item.Name)
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
// Resolve's full-text query used to fetch only `limit` rows before scoring,
// so the rows handed to the scorer were an arbitrary (or raw-trigram-only)
// subset — the true best match by final *quality* could be silently excluded
// entirely just because it did not also happen to be among the top rows by
// raw trigram alone.
//
// A fixture where the winner is simply the best by trigram (as the previous
// version of this test used, via an exact-match row) does NOT catch that bug:
// `ORDER BY similarity(...) DESC LIMIT <caller's limit>` ranks it first
// regardless of whether the scan limit is resolveScanLimit or the caller's
// limit, so reverting to the caller's limit would still pass. This fixture
// instead makes the winner best by *quality*
// (0.4*coverage + 0.3*precision + 0.3*trigram, see score.go) while ranking
// LAST of four candidates by raw trigram similarity, so it only survives a
// generous, ordered scan limit — not a scan limit tied to the caller's
// request size.
//
// Values below were verified against the actual pg_trgm extension before
// writing this test (docker exec kora-pg-test psql -U kora -d kora -c
// "SELECT similarity(...)"), against the query "zqxwx apple":
//
//	winner ("zqxwx apple pineapplecrumble"):      trigram=0.480 precision=2/3=0.667 quality=0.744
//	competitor ("zqxwx apple ab cd ef"):           trigram=0.600 precision=2/5=0.400 quality=0.700
//	competitor ("zqxwx apple st tu vw"):           trigram=0.571 precision=2/5=0.400 quality=0.691
//	competitor ("zqxwx apple ab cd ef gh"):        trigram=0.522 precision=2/6=0.333 quality=0.657
//
// All three competitors beat the winner on raw trigram alone (their extra
// tokens are short, so they dilute the trigram set less than the winner's
// one long extra token does) but lose on quality, because their extra tokens
// dilute token precision more. So `ORDER BY similarity(...) DESC LIMIT 3`
// (the caller's limit) keeps exactly the three competitors and drops the
// winner — which is exactly what a reintroduced `LIMIT <caller's limit>`
// bug would do.
func TestResolveDoesNotTruncateBeforeScoring(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	const winnerName = "Zqxwx apple pineapplecrumble"
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: "Zqxwx apple ab cd ef", Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: "Zqxwx apple st tu vw", Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: "Zqxwx apple ab cd ef gh", Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: winnerName, Provenance: ProvenanceUSDA, KcalPer100g: 100},
	})
	require.NoError(t, err)

	// Caller's limit (3) is smaller than the number of full-text matches (4),
	// and the winner ranks LAST of the four by raw trigram similarity — so a
	// pre-scoring SQL LIMIT keyed on the caller's limit would keep the three
	// higher-trigram competitors and drop the winner before the Go scorer
	// ever saw it.
	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxwx apple", nil, 3)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, winnerName, cands[0].Item.Name,
		"the quality-best row must win top-1 even though it ranks last of four by raw trigram similarity")
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
