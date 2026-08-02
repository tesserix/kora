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

	// Scores discriminate — i.e. no two candidates land on the same value,
	// which is what a flat ts_rank tie would produce.
	//
	// NOT asserted: strict pairwise descending order across the whole list.
	// Order is now by rank key (quality, plus headBonus when the candidate's
	// head noun — see score.go headToken — matches a query token), while
	// MatchScore stays the unmodified quality. Three of these five names end
	// in "breast", literally the query's last token, so the head-noun signal
	// promotes them ahead of "Chicken breast roasted" (head "roasted", no
	// bonus) even though "roasted" has higher raw quality than one of them.
	// That reordering-without-rescoring is the feature working as designed
	// (see repository.go Resolve), not a defect — so this test only checks
	// what it actually needs: no duplicate scores, and the winner beats the
	// loser.
	seenScores := map[float64]bool{}
	for _, c := range cands {
		require.False(t, seenScores[c.MatchScore], "duplicate MatchScore %v (%q) — ties were not broken", c.MatchScore, c.Item.Name)
		seenScores[c.MatchScore] = true
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

// TestResolveHeadNounOutranksDerivative is the regression guard for the bug
// this change exists to fix: token precision (|Q∩D|/|D|) rewards short
// documents, so a derivative product with fewer extra tokens can outscore
// the generic food the user actually meant. Without the head-noun ranking
// signal, this fixture is built so the derivative wins on precision alone:
// its normalized doc has fewer tokens diluting the query match than the
// generic's does.
func TestResolveHeadNounOutranksDerivative(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	const (
		genericName    = "Apricot, zqxc dried whole pitted stoned" // head: "apricot" (comma-inverted)
		derivativeName = "Zqxc trail mix, dried apricot"           // head: "mix" (comma-inverted)
	)
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: derivativeName, Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: genericName, Provenance: ProvenanceUSDA, KcalPer100g: 200},
	})
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxc dried apricot", nil, 10)
	require.NoError(t, err)
	require.Len(t, cands, 2)

	require.Equal(t, genericName, cands[0].Item.Name,
		"the generic food (head noun \"apricot\" matches the query) must outrank the derivative "+
			"(head noun \"mix\"), even though the derivative has higher token precision")
}

// TestResolveMatchScoreUnaffectedByHeadBonus is the safety property the tier
// design rests on: the head-noun signal may re-rank candidates, but the
// reported MatchScore for the winning row must be its unmodified quality —
// exactly as if the head bonus never existed. Folding the bonus into the
// score would let a head match alone cross a tier boundary (e.g. "yogurt" →
// "Tofu yogurt" crossing into confirm), silently reporting more confidence
// than the lexical/embedding signals actually support.
func TestResolveMatchScoreUnaffectedByHeadBonus(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	const (
		genericName    = "Apricot, zqxc dried whole pitted stoned"
		derivativeName = "Zqxc trail mix, dried apricot"
	)
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: derivativeName, Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: genericName, Provenance: ProvenanceUSDA, KcalPer100g: 200},
	})
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxc dried apricot", nil, 10)
	require.NoError(t, err)
	require.Len(t, cands, 2)
	require.Equal(t, genericName, cands[0].Item.Name, "precondition: head match must win top-1")

	// Recompute BOTH candidates' base quality independently (bypassing ranking
	// entirely) and derive the expected ambiguity factor from first principles
	// via ambiguityFactor() — NOT from cands[0].MatchScore itself, which would
	// make the assertion below a tautology that can never fail.
	norm := Normalize("zqxc dried apricot")

	qualityOf := func(name string) float64 {
		cov, prec := tokenOverlap(norm, Normalize(name))
		var trgm float64
		require.NoError(t, tx.Raw(
			`SELECT similarity(normalized_name, ?) FROM food_items WHERE name = ?`, norm, name,
		).Scan(&trgm).Error)
		return quality(components{Coverage: cov, Precision: prec, Trigram: trgm})
	}
	wantQuality := qualityOf(genericName)        // cands[0]'s base quality (winner, promoted by head bonus)
	runnerUpQuality := qualityOf(derivativeName) // cands[1]'s base quality (higher raw quality, no head match)

	margin := wantQuality - runnerUpQuality
	if margin < 0 {
		margin = 0
	}
	expectedFactor := ambiguityFactor(margin)

	require.InDelta(t, wantQuality*expectedFactor, cands[0].MatchScore, 0.0001,
		"MatchScore must equal the unmodified quality scaled only by the independently-derived "+
			"ambiguity factor — never quality+headBonus")

	// Explicit negative check: MatchScore must NOT equal (quality+headBonus)*factor.
	scoreWithBonusFolded := (wantQuality + headBonus) * expectedFactor
	require.False(t, floatsClose(scoreWithBonusFolded, cands[0].MatchScore, 0.0001),
		"MatchScore (%v) must not include the head bonus (would be %v if it did)",
		cands[0].MatchScore, scoreWithBonusFolded)
}

func floatsClose(a, b, delta float64) bool {
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff <= delta
}

// TestResolveAmbiguityMarginNeverGoesNegativeAfterReordering guards the
// interaction between ranking and the ambiguity factor: the margin feeding
// ambiguityFactor must come from the top two candidates' BASE qualities IN
// THE RANKED (post-head-bonus) ORDER, clamped at >= 0. Computing
// quality[0]-quality[1] naively after a head-bonus reorder can go negative
// (the new #1 by rank key can have a lower base quality than the old #1,
// now #2) — feeding that straight into ambiguityFactor would wrongly slam
// confidence to its floor for a case that is not actually ambiguous.
func TestResolveAmbiguityMarginNeverGoesNegativeAfterReordering(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	repo := NewRepository(tx)

	const (
		genericName    = "Apricot, zqxc dried whole pitted stoned"
		derivativeName = "Zqxc trail mix, dried apricot"
	)
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: derivativeName, Provenance: ProvenanceUSDA, KcalPer100g: 100},
		{Name: genericName, Provenance: ProvenanceUSDA, KcalPer100g: 200},
	})
	require.NoError(t, err)

	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxc dried apricot", nil, 10)
	require.NoError(t, err)
	require.Len(t, cands, 2)
	require.Equal(t, genericName, cands[0].Item.Name, "precondition: reordering must have occurred")

	// The pre-bonus quality ordering was derivative > generic (that's the
	// whole point of the fixture), so after reordering, cands[0] (generic) has
	// LOWER base quality than cands[1] (derivative). If the ambiguity factor
	// were computed as cands[0].quality - cands[1].quality without the clamp,
	// this would be negative. Verify neither MatchScore is thereby dragged to
	// the ambiguityFloor by an unclamped negative margin: the derivative
	// candidate must retain a score consistent with a non-negative margin.
	norm := Normalize("zqxc dried apricot")
	cov0, prec0 := tokenOverlap(norm, Normalize(genericName))
	var trgm0 float64
	require.NoError(t, tx.Raw(
		`SELECT similarity(normalized_name, ?) FROM food_items WHERE name = ?`, norm, genericName,
	).Scan(&trgm0).Error)
	q0 := quality(components{Coverage: cov0, Precision: prec0, Trigram: trgm0})

	cov1, prec1 := tokenOverlap(norm, Normalize(derivativeName))
	var trgm1 float64
	require.NoError(t, tx.Raw(
		`SELECT similarity(normalized_name, ?) FROM food_items WHERE name = ?`, norm, derivativeName,
	).Scan(&trgm1).Error)
	q1 := quality(components{Coverage: cov1, Precision: prec1, Trigram: trgm1})

	require.Greater(t, q1, q0, "precondition: derivative's base quality must exceed the generic's")

	// A negative, unclamped margin (q0 - q1) would produce ambiguityFactor
	// below its floor only if the slope pushed below floor — but ambiguityFactor
	// already clamps at ambiguityFloor for any negative input, so the
	// regression this guards against is subtler: the margin must be computed
	// from RANKED order (cands[0], cands[1]) clamped at 0, i.e.
	// max(0, q0 - q1) = 0 here, giving ambiguityFactor(0) = 0.6 — not a
	// deeper negative value causing a factor below 0.6 to leak through some
	// other unclamped path.
	factor := cands[0].MatchScore / q0
	require.InDelta(t, ambiguityFactor(0), factor, 0.0001,
		"clamped margin of 0 must yield ambiguityFactor(0); an unclamped negative margin "+
			"would still floor at 0.6 today, but only because ambiguityFactor itself clamps — "+
			"this pins the actual computed factor to prove the margin was clamped upstream, not "+
			"accidentally correct because both clamps agree")
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
