package providers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The gateway is addressed by a ROUTING ALIAS ("kora-auto"), not a model name:
// it picks the real model per capability and names it in the response. Recording
// the alias instead of what answered makes the ledger unable to show a routing
// change — kora#541, where identify silently moved from gemini-3.5-flash-lite to
// gemini-3.5-flash, a ~5x cost difference, with every row still saying
// "kora-auto". It also lands those rows on defaultModelPrice, defeating that
// fallback's purpose as an alarm for genuinely unknown models.
//
// Embed already recorded response.Model; these pin the same behaviour for the
// chat paths.
func newModelStubServer(t *testing.T, respondedModel, content string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := map[string]any{
			"id":     "completion-1",
			"object": "chat.completion",
			"choices": []map[string]any{{
				"index":         0,
				"message":       map[string]any{"role": "assistant", "content": content},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
		}
		if respondedModel != "" {
			body["model"] = respondedModel
		}
		require.NoError(t, json.NewEncoder(w).Encode(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestOpenAIProvider_IdentifyText_RecordsResolvedModelNotAlias(t *testing.T) {
	server := newModelStubServer(t, "gemini-3.5-flash", `{"guesses":[{"food":"apple","confidence":0.9}]}`)
	p := NewOpenAIProvider("test-key", server.URL+"/v1", "kora-auto", false)

	_, usage, err := p.IdentifyText(t.Context(), "apple")

	require.NoError(t, err)
	assert.Equal(t, "gemini-3.5-flash", usage.Model,
		"the ledger must name what served the call, not the alias it was requested by")
}

func TestOpenAIProvider_Decompose_RecordsResolvedModelNotAlias(t *testing.T) {
	server := newModelStubServer(t, "gemini-3.5-flash", `{"ingredients":[{"name":"chicken","portion_estimate":"100g","confidence":0.8}]}`)
	p := NewOpenAIProvider("test-key", server.URL+"/v1", "kora-auto", false)

	_, usage, err := p.Decompose(t.Context(), "chicken parma")

	require.NoError(t, err)
	assert.Equal(t, "gemini-3.5-flash", usage.Model)
}

func TestOpenAIProvider_GenerateText_RecordsResolvedModelNotAlias(t *testing.T) {
	server := newModelStubServer(t, "gemini-3.5-flash", "you have 55g protein to go")
	p := NewOpenAIProvider("test-key", server.URL+"/v1", "kora-auto", false)

	_, usage, err := p.GenerateText(t.Context(), "system", "user")

	require.NoError(t, err)
	assert.Equal(t, "gemini-3.5-flash", usage.Model)
}

// A response with no model field must leave the requested model in place rather
// than blanking it: an empty Model would fall through to defaultModelPrice too,
// trading one wrong price for another.
func TestOpenAIProvider_FallsBackToRequestedModelWhenResponseOmitsIt(t *testing.T) {
	server := newModelStubServer(t, "", `{"guesses":[{"food":"apple","confidence":0.9}]}`)
	p := NewOpenAIProvider("test-key", server.URL+"/v1", "configured-model", false)

	_, usage, err := p.IdentifyText(t.Context(), "apple")

	require.NoError(t, err)
	assert.Equal(t, "configured-model", usage.Model)
}

// An error path has no trustworthy resolved model, and must not invent one.
func TestOpenAIProvider_ErrorKeepsRequestedModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	p := NewOpenAIProvider("test-key", server.URL+"/v1", "configured-model", false)

	_, usage, err := p.IdentifyText(t.Context(), "apple")

	require.Error(t, err)
	assert.Equal(t, "configured-model", usage.Model)
}
