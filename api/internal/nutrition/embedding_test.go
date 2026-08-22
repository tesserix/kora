package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// fixedVector768 returns a deterministic 768-dim vector where every element
// equals v — enough to exercise the embedding column/tier without needing a
// real embedding model.
func fixedVector768(v float32) []float32 {
	vec := make([]float32, 768)
	for i := range vec {
		vec[i] = v
	}
	return vec
}

// allMissingEmbeddings is a limit large enough to return every unembedded row
// in the dev index. RowsMissingEmbedding is `ORDER BY created_at LIMIT ?`, so a
// freshly seeded row sorts LAST — and the dev index carries a backlog of well
// over 15,000 unembedded rows (unlike prod, which is fully embedded). Passing a
// production-sized limit of 1000 therefore never reached the row these tests
// had just created. What they assert is membership of the queue, not position
// in it, so they ask for the whole queue.
const allMissingEmbeddings = 1_000_000

func TestRowsMissingEmbeddingAndSetEmbedding(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b-embed'") })

	seedFor(t, repo, []FoodItem{
		{Name: "Zqxembed grilled tofu", Brand: "test2b-embed", Provenance: ProvenanceAFCD, KcalPer100g: 120},
	})

	var item FoodItem
	require.NoError(t, db.First(&item, "name = ? AND brand = 'test2b-embed'", "Zqxembed grilled tofu").Error)

	// Freshly inserted row has no embedding yet.
	missing, err := repo.RowsMissingEmbedding(context.Background(), allMissingEmbeddings)
	require.NoError(t, err)
	require.True(t, containsID(missing, item.ID), "expected newly inserted row to be missing an embedding")

	vec := fixedVector768(0.5)
	require.NoError(t, repo.SetEmbedding(context.Background(), item.ID, vec))

	// After SetEmbedding, the row must no longer be "missing".
	missingAfter, err := repo.RowsMissingEmbedding(context.Background(), allMissingEmbeddings)
	require.NoError(t, err)
	require.False(t, containsID(missingAfter, item.ID), "expected row to no longer be missing an embedding")

	// The embedding tier of Resolve must now surface it for a near query
	// vector. The query phrase is deliberately unrelated to the item's name
	// (no alias/full-text overlap) so a match can only come from the
	// embedding tier — proving the tier itself, not full-text, found it.
	//
	// Asks for resolveScanLimit rather than the production limit of 5
	// (kora#151): what this asserts is that the row is REACHABLE via the
	// embedding tier, not that it outranks the rest of a shared index that
	// already carries other embedded rows. A limit of 5 made the assertion
	// depend on ranking position against whatever the dev index happens to
	// hold.
	got, err := repo.Resolve(context.Background(), uuid.Nil, "unrelated banana smoothie phrase", fixedVector768(0.5), resolveScanLimit)
	require.NoError(t, err)

	var found *Candidate
	for i := range got {
		if got[i].Item.ID == item.ID && got[i].MatchTier == MatchEmbedding {
			found = &got[i]
		}
	}
	require.NotNil(t, found, "expected the seeded row to be resolved via the embedding tier")
}

// TestRowsMissingEmbeddingExcludesSoftDeleted proves a retired row never
// occupies a slot in the embedding backfill's worklist. Ordering is
// oldest-created-first, so an old retired row that was never embedded would
// otherwise sit permanently at the head of this queue, burning one of
// Gemini's ~1000 free-tier requests/day on every single cmd/embed run
// forever. Seeds a live and a retired row inside a rolled-back transaction
// and asserts both halves: the live one is still returned, the retired one
// is not.
func TestRowsMissingEmbeddingExcludesSoftDeleted(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)

	live := FoodItem{Name: "Live Missing-Embedding Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&live).Error)
	retired := FoodItem{Name: "Retired Missing-Embedding Food " + uuid.NewString(), Provenance: ProvenanceCurated, KcalPer100g: 100}
	require.NoError(t, tx.Create(&retired).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	missing, err := repo.RowsMissingEmbedding(context.Background(), allMissingEmbeddings)
	require.NoError(t, err)
	require.True(t, containsID(missing, live.ID), "a live unembedded row must still be queued for embedding")
	require.False(t, containsID(missing, retired.ID), "a retired row must not consume a scarce embedding-backfill slot")
}

func TestSearchReferenceFoodsUsesOnlyReviewedCountryDatasets(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	query := partialVector768(233, 1)

	au := FoodItem{
		Name: "Reference AU " + uuid.NewString(), Provenance: ProvenanceAFCD,
		Locale: LocaleAU, KcalPer100g: 120, ProteinPer100g: 20,
	}
	in := FoodItem{
		Name: "Reference IN " + uuid.NewString(), Provenance: ProvenanceIFCT,
		Locale: LocaleIN, KcalPer100g: 180, ProteinPer100g: 12,
	}
	unreviewed := FoodItem{
		Name: "Unreviewed estimate " + uuid.NewString(), Provenance: ProvenanceUserEstimate,
		KcalPer100g: 1, ProteinPer100g: 99,
	}
	retired := FoodItem{
		Name: "Retired reference " + uuid.NewString(), Provenance: ProvenanceUSDA,
		Locale: LocaleUS, KcalPer100g: 100,
	}
	for _, item := range []*FoodItem{&au, &in, &unreviewed, &retired} {
		require.NoError(t, tx.Create(item).Error)
		require.NoError(t, repo.SetEmbedding(t.Context(), item.ID, query))
	}
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	got, err := repo.SearchReferenceFoods(t.Context(), query, LocaleAU, 25)
	require.NoError(t, err)

	ids := make([]uuid.UUID, 0, len(got))
	for _, item := range got {
		ids = append(ids, item.Item.ID)
	}
	require.Contains(t, ids, au.ID)
	require.Contains(t, ids, in.ID)
	require.NotContains(t, ids, unreviewed.ID, "user estimates must never become shared AI evidence")
	require.NotContains(t, ids, retired.ID)
	require.Equal(t, au.ID, got[0].Item.ID, "the caller's locale should break equally similar ties")
}

func containsID(items []FoodItem, id uuid.UUID) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

// partialVector768 returns a deterministic 768-dim vector where the first n
// elements equal v and the rest are 0. fixedVector768 alone cannot produce a
// moderate, controllable cosine similarity: any two uniform vectors of the
// same sign are perfectly parallel (cosine 1) regardless of magnitude, so
// every fixedVector768(v) is either identical-direction (cosine 1) or
// opposite-direction (cosine -1) to every other. A partial vector gives a
// third, computable point in between.
func partialVector768(n int, v float32) []float32 {
	vec := make([]float32, 768)
	for i := 0; i < n; i++ {
		vec[i] = v
	}
	return vec
}

// TestResolvePoolsEmbeddingAgainstFullText guards the path every production
// call actually takes (api/internal/ai/resolver.go always passes a real
// queryVec, see lines 353 and 421) but that TestRowsMissingEmbeddingAndSetEmbedding
// above never exercises: an embedding candidate and a full-text candidate
// competing in the SAME pool, decided by score — not by which SQL query
// happened to find them first. That test's query has zero lexical overlap
// with the seeded row, so full-text and embedding never actually compete.
//
// Fixture (values verified via `docker exec kora-pg-test psql -U kora -d kora
// -c "SELECT similarity(...)"` before writing this test, against the query
// "zqxpool salmon"):
//
//	x ("Zqxpool salmon teriyaki glaze extra filler"): full-text only, no
//	  embedding. coverage=1, precision=2/6=0.333, trigram=0.349 ->
//	  lexical=0.4+0.1+0.105=0.605.
//	y ("Zqymelon breeze smoothie"): embedding only — it shares NO token with
//	  the query (to_tsvector(...) @@ plainto_tsquery(...) is false), so it
//	  can only be found via the embedding tier. Its embedding is identical to
//	  queryVec (fixedVector768(1.0)), so cosine similarity is 1.0 and
//	  embeddingFactor*EmbSim = 0.85*1.0 = 0.85 — above x's 0.605. It carries
//	  its own "zqxy" nonce rather than the query's: the lookup below recovers
//	  each row's id BY NAME, and a plain "Melon breeze smoothie" could match
//	  an ambient OFF row, which SetEmbedding would then write to — mutating a
//	  row this test did not create (kora#151).
//	z ("Zqxpool salmon mild dilution filler wordset"): recalled by BOTH
//	  queries — it shares the query's two tokens (full-text: coverage=1,
//	  precision=2/6=0.333, trigram=0.349 -> lexical=0.605, same shape as x)
//	  AND carries an embedding (partialVector768(384, 1.0)) whose cosine
//	  similarity to queryVec is 384/sqrt(384*768)=0.7071, giving
//	  0.85*0.7071=0.601. Both signals lose to y's 0.85; z exists purely to
//	  prove a row found by both queries is scored once, not twice.
//
// Expected outcome: y OUTRANKS both x and z on SCORE (0.85 beats their
// ~0.60) and its MatchTier is MatchEmbedding because the embedding term
// produced the winning score — not because "embedding" is preferred over
// "full_text" as a tier. z appears exactly once in the pool despite being
// recalled by both queries, and x is still present as a genuine (losing)
// competitor.
//
// The ordering assertion is RELATIVE to the three fixture rows, not "y is
// cands[0]" (kora#151). This test used to TRUNCATE food_items so that top-1
// and "best of the fixture" were the same thing; against the shared dev index
// the embedding tier scans every embedded row in the table, so an ambient row
// may legitimately place above y without saying anything about whether the
// two tiers were pooled and scored correctly — which is all this test is for.
func TestResolvePoolsEmbeddingAgainstFullText(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)

	const (
		xName = "Zqxpool salmon teriyaki glaze extra filler"
		yName = "Zqymelon breeze smoothie"
		zName = "Zqxpool salmon mild dilution filler wordset"
	)
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: xName, Provenance: ProvenanceUSDA, KcalPer100g: 150},
		{Name: yName, Provenance: ProvenanceUSDA, KcalPer100g: 150},
		{Name: zName, Provenance: ProvenanceUSDA, KcalPer100g: 150},
	})
	require.NoError(t, err)

	var x, y, z FoodItem
	require.NoError(t, tx.First(&x, "name = ?", xName).Error)
	require.NoError(t, tx.First(&y, "name = ?", yName).Error)
	require.NoError(t, tx.First(&z, "name = ?", zName).Error)

	// x deliberately gets no embedding — it is full-text only.
	require.NoError(t, repo.SetEmbedding(context.Background(), y.ID, fixedVector768(1.0)))
	require.NoError(t, repo.SetEmbedding(context.Background(), z.ID, partialVector768(384, 1.0)))

	queryVec := fixedVector768(1.0)
	cands, err := repo.Resolve(context.Background(), uuid.Nil, "zqxpool salmon", queryVec, 10)
	require.NoError(t, err)
	require.NotEmpty(t, cands)

	// Positions and occurrence counts of the three fixture rows, and nothing
	// else in the result.
	pos := map[uuid.UUID]int{}
	count := map[uuid.UUID]int{}
	var yTier string
	for i, c := range cands {
		switch c.Item.ID {
		case x.ID, y.ID, z.ID:
			if count[c.Item.ID] == 0 {
				pos[c.Item.ID] = i
			}
			count[c.Item.ID]++
			if c.Item.ID == y.ID {
				yTier = c.MatchTier
			}
		}
	}
	require.Equal(t, 1, count[x.ID], "the full-text-only candidate must still be present, exactly once")
	require.Equal(t, 1, count[y.ID], "the embedding-only candidate must be present, exactly once")
	require.Equal(t, 1, count[z.ID], "a row recalled by both the full-text and embedding queries must be scored once, not twice")

	require.Less(t, pos[y.ID], pos[x.ID],
		"the embedding-only candidate must outrank the full-text-only one on score (0.85 vs ~0.60)")
	require.Less(t, pos[y.ID], pos[z.ID],
		"the embedding-only candidate must outrank the dual-recall one on score (0.85 vs ~0.60)")
	require.Equal(t, MatchEmbedding, yTier)
}
