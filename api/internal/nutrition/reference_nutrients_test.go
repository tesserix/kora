package nutrition

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestReviewedWorldReferencesExposeMeasuredNutrients(t *testing.T) {
	tx := fixtureOnlyTx(t)
	repo := NewRepository(tx)
	vector := partialVector768(310, 1)
	sodium := 420.0
	for _, provenance := range []string{ProvenanceUSDA, ProvenanceCoFID, ProvenanceMEXT} {
		item := FoodItem{Name: "Reference fixture " + uuid.NewString(), Provenance: provenance, KcalPer100g: 100, Nutrients: Nutrients{SodiumMgPer100g: &sodium}}
		require.NoError(t, tx.Create(&item).Error)
		require.NoError(t, repo.SetEmbedding(t.Context(), item.ID, vector))
	}
	items, err := repo.SearchReferenceFoods(t.Context(), vector, LocaleGB, 10, nil)
	require.NoError(t, err)
	require.Len(t, items, 3)
	for _, item := range items {
		require.NotNil(t, item.Item.SodiumMgPer100g)
		require.Equal(t, 420.0, *item.Item.SodiumMgPer100g)
	}
}
