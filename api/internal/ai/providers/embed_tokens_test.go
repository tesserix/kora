package providers

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// estimateEmbedTokens is an approximation, so the meaningful test is not "does
// it equal N for input X" — it is "does it still track what the provider
// actually charges". testdata/embed_token_counts.json holds provider-reported
// prompt_tokens for the 75 distinct phrases in testdata/eval/ranking.sample.jsonl,
// captured through the production gateway, whose embedding response (unlike the
// direct Gemini SDK's) returns a real count.
//
// That fixture is what makes this calibration checkable without spending money
// or reaching the network. Regenerate it only against the gateway, never by
// hand: a fixture edited to match the estimator would test nothing.
const embedEstimateTolerance = 0.10

func loadTokenFixture(t *testing.T) map[string]int {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "embed_token_counts.json"))
	require.NoError(t, err, "provider-reported token fixture must be present")
	var counts map[string]int
	require.NoError(t, json.Unmarshal(raw, &counts))
	require.NotEmpty(t, counts)
	return counts
}

// The aggregate is what bills, so the aggregate is what is bounded. Per-phrase
// error stays around half a token and is deliberately NOT asserted tightly —
// pinning it would be pinning the tokenizer, which this does not model.
func TestEstimateEmbedTokens_TracksProviderCounts(t *testing.T) {
	counts := loadTokenFixture(t)

	var estimated, actual int
	for phrase, reported := range counts {
		estimated += estimateEmbedTokens(phrase)
		actual += reported
	}
	require.Positive(t, actual)

	drift := math.Abs(float64(estimated-actual)) / float64(actual)
	t.Logf("estimated=%d provider=%d drift=%+.1f%% over %d phrases",
		estimated, actual, 100*float64(estimated-actual)/float64(actual), len(counts))

	assert.LessOrEqual(t, drift, embedEstimateTolerance,
		"estimate drifted from provider-reported counts; recalibrate charsPerToken (kora#538)")
}

// Runes, not bytes: a multi-byte phrase must not be charged by its UTF-8
// length. "日本語" is 3 runes and 9 bytes.
func TestEstimateEmbedTokens_CountsRunesNotBytes(t *testing.T) {
	assert.Equal(t, estimateEmbedTokens("abc"), estimateEmbedTokens("日本語"))
}
