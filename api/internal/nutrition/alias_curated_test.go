package nutrition

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// TestCuratedParmaAliasResolves proves the curated AU abbreviation actually
// reaches the cooked parmigiana row, end to end through the real alias tier.
//
// The file-shape test in internal/nutrition/ingest cannot show this: it checks
// the entry is well-formed, not that it WORKS. cmd/ingest only warns when an
// alias fails to resolve, so a mistyped target ships silently and the alias
// simply never fires. This pins the exact food name the entry depends on — if
// the AUSNUT row is ever renamed, this fails instead of degrading quietly.
//
// "chicken parma" has ZERO lexical candidates (verified against the production
// index): "parma" shares no token with "parmigiana", so nothing but an alias
// can reach the row.
func TestCuratedParmaAliasResolves(t *testing.T) {
	const target = "Chicken, schnitzel, breadcrumb coating, topped with tomato sauce & cheese (parmigiana)"

	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))

	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	item := FoodItem{
		ID: uuid.New(), Name: target, NormalizedName: Normalize(target),
		Provenance: "ausnut", KcalPer100g: 219, EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&item).Error)

	applied, unresolved, err := repo.UpsertGlobalAliases(ctx, curated)
	require.NoError(t, err)
	require.Positive(t, applied, "no curated alias resolved; unresolved=%v", unresolved)

	// Guard the premise: without the alias there is genuinely nothing to find,
	// so a pass below cannot be coming from lexical matching.
	lexical, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "chicken parmigiana-not-a-word"}, nil, 5)
	require.NoError(t, err)
	require.Empty(t, lexical)

	for _, phrase := range []string{"chicken parma", "chicken parmi", "parmi"} {
		got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: phrase}, nil, 5)
		require.NoError(t, err, phrase)
		require.NotEmpty(t, got, "%q resolved to nothing", phrase)
		require.Equal(t, item.ID, got[0].Item.ID, "%q must resolve to the parmigiana row, got %q", phrase, got[0].Item.Name)
		require.Equal(t, MatchAlias, got[0].MatchTier, "%q must resolve via the alias tier", phrase)
	}
}
