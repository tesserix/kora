package nutrition

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAddAliasLowerTrimIdempotentAndResolvable(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()

	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2c'") })
	t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE lower(alias) = ?", "brekkie") })

	seedFor(t, repo, []FoodItem{
		{Name: "Rolled Oats", Brand: "test2c", Provenance: ProvenanceAFCD, KcalPer100g: 379},
	})
	var item FoodItem
	require.NoError(t, db.First(&item, "name = ? AND brand = 'test2c'", "Rolled Oats").Error)

	// Mixed-case + surrounding space must be stored lower+trim.
	if err := repo.AddAlias(ctx, "  Brekkie  ", item.ID); err != nil {
		t.Fatal(err)
	}
	// Idempotent: second call for the same (alias,item) inserts nothing extra.
	if err := repo.AddAlias(ctx, "brekkie", item.ID); err != nil {
		t.Fatal(err)
	}
	var n int64
	db.Raw("SELECT count(*) FROM food_aliases WHERE lower(alias) = ? AND food_item_id = ?", "brekkie", item.ID).Scan(&n)
	if n != 1 {
		t.Fatalf("alias rows = %d, want 1 (idempotent)", n)
	}
	// Resolvable via the alias tier (score 1.0).
	cands, err := repo.Resolve(ctx, "Brekkie", nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) == 0 || cands[0].Item.ID != item.ID || cands[0].MatchTier != MatchAlias {
		t.Fatalf("alias not resolved: %+v", cands)
	}
	// Blank alias is a safe no-op.
	if err := repo.AddAlias(ctx, "   ", item.ID); err != nil {
		t.Fatalf("blank alias should be a no-op, got %v", err)
	}
}
