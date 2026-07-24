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
	missing, err := repo.RowsMissingEmbedding(context.Background(), 1000)
	require.NoError(t, err)
	require.True(t, containsID(missing, item.ID), "expected newly inserted row to be missing an embedding")

	vec := fixedVector768(0.5)
	require.NoError(t, repo.SetEmbedding(context.Background(), item.ID, vec))

	// After SetEmbedding, the row must no longer be "missing".
	missingAfter, err := repo.RowsMissingEmbedding(context.Background(), 1000)
	require.NoError(t, err)
	require.False(t, containsID(missingAfter, item.ID), "expected row to no longer be missing an embedding")

	// The embedding tier of Resolve must now surface it for a near query
	// vector. The query phrase is deliberately unrelated to the item's name
	// (no alias/full-text overlap) so a match can only come from the
	// embedding tier — proving the tier itself, not full-text, found it.
	got, err := repo.Resolve(context.Background(), "unrelated banana smoothie phrase", fixedVector768(0.5), 5)
	require.NoError(t, err)

	var found *Candidate
	for i := range got {
		if got[i].Item.ID == item.ID && got[i].MatchTier == MatchEmbedding {
			found = &got[i]
		}
	}
	require.NotNil(t, found, "expected the seeded row to be resolved via the embedding tier")
}

func containsID(items []FoodItem, id uuid.UUID) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}
