package nutrition

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// BackfillServings exists because ingest.Run lets the alphabetically-first
// file win a name+brand collision, so afcd_release3.json claims 315 names that
// ausnut.json also carries — and AFCD states no servings while AUSNUT ships
// measures. Without this the measured serving is silently discarded.
func TestBackfillServingsFillsRowsThatHaveNone(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)
	ctx := context.Background()

	// Stands in for the AFCD row that won the insert: no serving of any kind.
	bare := FoodItem{
		Name: "Backfill Probe, raw", Brand: "", Provenance: ProvenanceAFCD,
		KcalPer100g: 50, NormalizedName: Normalize("Backfill Probe, raw"),
	}
	require.NoError(t, tx.Create(&bare).Error)

	// Stands in for AUSNUT's view of the same food, carrying measures.
	units, err := json.Marshal([]map[string]any{{"name": "cup", "amount": 1, "base_amount": 158}})
	require.NoError(t, err)
	incoming := []FoodItem{{
		Name: "Backfill Probe, raw", Brand: "",
		ServingGrams: 158, ServingDesc: "1 cup", ServingUnits: units,
	}}

	n, err := repo.BackfillServings(ctx, incoming)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	var got FoodItem
	require.NoError(t, tx.First(&got, "name = ?", "Backfill Probe, raw").Error)
	require.Equal(t, 158.0, got.ServingGrams)
	require.Equal(t, "1 cup", got.ServingDesc)
	require.Contains(t, string(got.ServingUnits), "cup")

	// A second run must change nothing — this runs on every ArgoCD sync.
	n2, err := repo.BackfillServings(ctx, incoming)
	require.NoError(t, err)
	require.Zero(t, n2, "backfill must be idempotent")
}

// A row that already has serving data belongs to whichever source owns it.
// Overwriting would let file ordering decide a logged portion, which is the
// same class of bug the duplicate-descriptor collapse avoids.
func TestBackfillServingsNeverOverwritesExistingData(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	owned := FoodItem{
		Name: "Owned Probe", Provenance: ProvenanceUSDA, KcalPer100g: 100,
		ServingGrams: 30, ServingDesc: "1 bar",
		NormalizedName: Normalize("Owned Probe"),
	}
	require.NoError(t, tx.Create(&owned).Error)

	units, err := json.Marshal([]map[string]any{{"name": "cup", "amount": 1, "base_amount": 250}})
	require.NoError(t, err)
	n, err := repo.BackfillServings(context.Background(), []FoodItem{{
		Name: "Owned Probe", ServingGrams: 250, ServingDesc: "1 cup", ServingUnits: units,
	}})
	require.NoError(t, err)
	require.Zero(t, n)

	var got FoodItem
	require.NoError(t, tx.First(&got, "name = ?", "Owned Probe").Error)
	require.Equal(t, 30.0, got.ServingGrams, "an owning source's serving must survive")
	require.Equal(t, "1 bar", got.ServingDesc)
}

// Rows carrying nothing to contribute must not generate an UPDATE at all.
func TestBackfillServingsIgnoresItemsWithNoServingData(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	n, err := repo.BackfillServings(context.Background(), []FoodItem{
		{Name: "Nothing To Give", ServingGrams: 0},
	})
	require.NoError(t, err)
	require.Zero(t, n)
}
