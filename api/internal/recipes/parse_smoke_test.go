//go:build smoke

package recipes

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// pastedRecipe is a realistic paste: a title, a yield line, a quantified
// ingredient list, and method prose the extractor must ignore. Everything a
// user actually copies off a recipe site is here, including the noise.
const pastedRecipe = `Masoor Dal

Serves 4

Ingredients:
- 200g red lentils, rinsed
- 1 tbsp vegetable oil
- 1 medium onion, finely chopped
- 2 cloves garlic
- 1 tsp ground turmeric
- 400ml water
- salt to taste

Method:
Rinse the lentils until the water runs clear. Heat the oil in a heavy pan and
fry the onion until golden, about 8 minutes. Add the garlic and turmeric and
cook for another minute. Add the lentils and water, bring to a boil, then
simmer covered for 25 minutes until soft. Season and serve with rice.
`

// TestParseText_Smoke makes ONE real call to the configured AI provider and
// asserts the paste path survives a live model.
//
// This exists because the paste extractor is the least-verifiable part of the
// feature. ai.Provider.GenerateText enforces NO JSON schema — its own doc
// comment says it is for prose — so the strict-JSON contract in
// parseSystemPrompt is held up by prompt discipline alone. Every other test
// in this package drives a stub that returns exactly the JSON we asked for,
// which proves the decoding but assumes away the part most likely to break:
// whether a real model actually answers in bare JSON rather than prose, a
// fenced block, or JSON with commentary wrapped around it.
//
// Excluded from `go test ./...` (needs `-tags smoke`) and gated on both a
// provider key and a database, so it never runs by accident.
func TestParseText_Smoke(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY not set; skipping live recipe-parse smoke test")
	}

	ctx := context.Background()
	provider, err := providers.NewGeminiProvider(ctx, apiKey)
	require.NoError(t, err)

	db := testDB(t)
	userID := seedUser(t, db)

	p := NewParser(provider, nutrition.NewRepository(db))
	d, err := p.ParseText(ctx, userID, pastedRecipe)
	require.NoError(t, err, "a real model must produce parseable JSON for an ordinary pasted recipe")

	// The yield is stated in the paste ("Serves 4"). A model that ignores it
	// and defaults to 1 makes every per-serving figure four times too large,
	// so this is a correctness assertion, not a nicety.
	require.Equal(t, 4, d.Servings, "servings must come from the paste, not the default")
	require.Contains(t, strings.ToLower(d.Name), "dal", "the dish name must come from the paste")
	require.Equal(t, SourcePaste, d.Source)

	// Seven ingredient lines are listed. Exactness is the model's business,
	// but dropping most of them would mean the extraction is not usable.
	require.GreaterOrEqual(t, len(d.Ingredients), 5,
		"most ingredient lines must survive extraction")

	// Method prose must not leak in as ingredients.
	for _, in := range d.Ingredients {
		require.NotContains(t, strings.ToLower(in.RawText), "simmer",
			"method prose must not be extracted as an ingredient: %q", in.RawText)
		require.LessOrEqual(t, len(in.RawText), maxRawTextLen)
	}

	// Nutrition must never originate in the model. Every resolved ingredient's
	// grams must be positive, and any ingredient the food index could not
	// match must be labelled unresolved rather than silently given a food.
	for _, in := range d.Ingredients {
		if in.FoodItemID != nil {
			require.Greater(t, in.Grams, 0.0, "a resolved ingredient needs a positive portion: %q", in.RawText)
			require.NotEmpty(t, in.Name, "a resolved ingredient must carry the matched food's canonical name")
		} else {
			require.Zero(t, in.Grams, "an unresolved ingredient must carry no portion: %q", in.RawText)
			require.Empty(t, in.Name)
		}
	}

	t.Logf("parsed %q, %d servings, %d ingredients", d.Name, d.Servings, len(d.Ingredients))
	for _, in := range d.Ingredients {
		resolved := "UNRESOLVED"
		if in.FoodItemID != nil {
			resolved = in.Name
		}
		t.Logf("  %-40q -> %-40s %6.1fg assumed=%v", in.RawText, resolved, in.Grams, in.PortionAssumed)
	}
}
