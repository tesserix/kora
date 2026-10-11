package nutrition

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// TestResolveFindsAmpersandNameFromAndPhrase pins kora#235's root cause.
//
// Food names in AUSNUT/AFCD spell the conjunction as "&" ("Bacon & egg roll"),
// and Normalize() turns "&" into whitespace, so the row's normalized_name is
// "bacon egg roll" — it carries no conjunction token at all. Users type the
// word: "bacon and egg roll".
//
// The recall predicate is plainto_tsquery('simple', ...), and the `simple`
// text-search configuration has NO stopword list, so "and" survives as a
// mandatory lexeme and the query becomes 'bacon' & 'and' & 'egg' & 'roll'.
// No such row exists, so full-text retrieval returned ZERO candidates and the
// correct row was never ranked at all — production then fell through to the
// embedding tier and logged an unrelated food at `auto`.
//
// This is a RETRIEVAL defect, not a ranking one: no change to the scorer can
// promote a row that was never a candidate.
func TestResolveFindsAmpersandNameFromAndPhrase(t *testing.T) {
	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	want := FoodItem{
		ID:             uuid.New(),
		Name:           "Bacon & egg roll",
		NormalizedName: Normalize("Bacon & egg roll"),
		Provenance:     "ausnut",
		KcalPer100g:    271.5,
	}
	require.NoError(t, tx.Create(&want).Error)

	// Guard the premise rather than assuming it: the row really does lose its
	// conjunction on normalization. If this ever stops holding, the test below
	// would pass for a reason that has nothing to do with the fix.
	require.Equal(t, "bacon egg roll", want.NormalizedName)

	got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "bacon and egg roll"}, nil, 10)
	require.NoError(t, err)

	var found bool
	for _, c := range got {
		if c.Item.ID == want.ID {
			found = true
			break
		}
	}
	require.True(t, found,
		"a phrase spelling the conjunction as \"and\" must still retrieve a row that spells it \"&\"; got %d candidates", len(got))
}
