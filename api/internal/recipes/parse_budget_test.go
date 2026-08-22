package recipes

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// mobileRequestTimeoutMs reads REQUEST_TIMEOUT_MS straight out of the mobile
// client rather than restating it, so this test fails if EITHER side of the
// relationship moves. Duplicated from ai.mobileRequestTimeoutMs (router_test.go)
// because that helper is unexported and recipes cannot import across
// package-test boundaries. The path is relative to this package.
func mobileRequestTimeoutMs(t *testing.T) time.Duration {
	t.Helper()
	path := filepath.Join("..", "..", "..", "apps", "mobile", "src", "lib", "api.ts")
	src, err := os.ReadFile(path)
	require.NoError(t, err, "the mobile client's api.ts is the other half of this contract")

	m := regexp.MustCompile(`REQUEST_TIMEOUT_MS\s*=\s*([0-9_]+)`).FindSubmatch(src)
	require.NotNil(t, m, "REQUEST_TIMEOUT_MS not found in %s — it is what bounds every budget here", path)
	ms, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
	require.NoError(t, err)
	return time.Duration(ms) * time.Millisecond
}

// TestRecipePhotoBudgetsFitInsideTheMobileClientDeadline is the recipe-photo
// analogue of ai.TestGenerateBudgetsFitInsideTheMobileClientDeadline: the
// worst case of ParsePhoto's two provider calls (IdentifyPhoto, then
// Decompose with its own fallback leg) must finish inside the mobile
// client's abort deadline, with margin for the network and the rest of the
// request — otherwise the app has already given up and the server is doing
// (and paying for) work nobody is listening for.
func TestRecipePhotoBudgetsFitInsideTheMobileClientDeadline(t *testing.T) {
	clientDeadline := mobileRequestTimeoutMs(t)

	assert.Less(t, recipePhotoBudget, clientDeadline,
		"a photo budget at or above the client's deadline leaves no room for the Decompose call that follows")
	assert.LessOrEqual(t, recipePhotoBudget+recipeDecomposeBudget, clientDeadline-3*time.Second,
		"both legs together must fit inside the client's deadline with margin, or the Decompose fallback is theatre")
}

// slowFakeProvider implements ai.Provider for use as a Router leg. Only the
// methods ParsePhoto exercises are meaningful: IdentifyPhoto and Decompose.
// decomposeDelay lets a Decompose call outlive a tight Router.TextBudget
// override so the fallback leg is actually exercised, without sleeping
// anywhere near the real 15s/7s production windows.
type slowFakeProvider struct {
	name string

	guesses  []ai.Guess
	photoErr error

	decomposeDelay time.Duration
	ingredients    []ai.IngredientGuess
	decomposeErr   error
}

func (s *slowFakeProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{Provider: s.name}, nil
}
func (s *slowFakeProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return s.guesses, ai.Usage{Provider: s.name}, s.photoErr
}
func (s *slowFakeProvider) IdentifyBodyComposition(context.Context, []byte, string) (ai.BodyCompositionReading, ai.Usage, error) {
	return ai.BodyCompositionReading{}, ai.Usage{Provider: s.name}, nil
}
func (s *slowFakeProvider) Decompose(_ context.Context, _ string) ([]ai.IngredientGuess, ai.Usage, error) {
	if s.decomposeDelay > 0 {
		time.Sleep(s.decomposeDelay)
	}
	return s.ingredients, ai.Usage{Provider: s.name}, s.decomposeErr
}
func (s *slowFakeProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{Provider: s.name}, nil
}
func (s *slowFakeProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{Provider: s.name}, nil
}
func (s *slowFakeProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return "", ai.Usage{Provider: s.name}, nil
}
func (s *slowFakeProvider) Name() string { return s.name }

// TestParsePhotoReachesTheDecomposeFallback proves the fallback leg wired up
// by recipeDecomposeBudget is actually reachable, not just arithmetically
// plausible: a primary that outlives the Router's (tiny, test-overridden)
// text budget still lets Decompose succeed via the fallback, and ParsePhoto
// returns a usable draft rather than a parse failure. The Router's budgets
// are overridden to tiny test values here so recipeDecomposeBudget itself is
// never the binding constraint in this test run — that constant is covered
// separately by TestRecipePhotoBudgetsFitInsideTheMobileClientDeadline.
func TestParsePhotoReachesTheDecomposeFallback(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	primary := &slowFakeProvider{
		name:           "primary-stub",
		guesses:        []ai.Guess{{Food: "dal", Confidence: 0.9}},
		decomposeDelay: 40 * time.Millisecond, // outlives the router's overridden TextBudget below
		decomposeErr:   nil,
	}
	fallback := &slowFakeProvider{
		name:        "fallback-stub",
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "100 g"}},
	}
	router := &ai.Router{
		Primary:        primary,
		Fallback:       fallback,
		TextBudget:     10 * time.Millisecond,
		FallbackBudget: 500 * time.Millisecond,
	}
	meter := &stubMeter{}
	p := NewParser(router, nutrition.NewRepository(db), meter)

	draft, err := p.ParsePhoto(context.Background(), userID, []byte("jpeg"), "image/jpeg")

	require.NoError(t, err, "the fallback leg must be reachable within recipeDecomposeBudget, not just arithmetically fit")
	require.NotEmpty(t, draft.Ingredients)
}
