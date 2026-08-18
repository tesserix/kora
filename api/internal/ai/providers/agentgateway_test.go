package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

type recordingDirectProvider struct {
	embedCalls      int
	photoCalls      int
	transcribeCalls int
}

func (*recordingDirectProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	panic("IdentifyText must use Agent Gateway")
}

func (p *recordingDirectProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	p.photoCalls++
	return []ai.Guess{{Food: "photo"}}, ai.Usage{Provider: "gemini"}, nil
}

func (*recordingDirectProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	panic("Decompose must use Agent Gateway")
}

func (p *recordingDirectProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	p.embedCalls++
	return []float32{1, 2, 3}, ai.Usage{Provider: "gemini", Model: "gemini-embedding-001"}, nil
}

func (p *recordingDirectProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	p.transcribeCalls++
	return "spoken", ai.Usage{Provider: "gemini"}, nil
}

func (*recordingDirectProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	panic("GenerateText must use Agent Gateway")
}

func (*recordingDirectProvider) Name() string { return "gemini" }

func TestAgentGatewayProviderKeepsEmbeddingAndMultimodalOnDirectVertex(t *testing.T) {
	t.Parallel()

	direct := &recordingDirectProvider{}
	provider := NewAgentGatewayProvider(direct, "gateway-key", "https://gateway.invalid/v1", "kora-auto")

	embedding, usage, err := provider.Embed(t.Context(), "apple")
	require.NoError(t, err)
	assert.Equal(t, []float32{1, 2, 3}, embedding)
	assert.Equal(t, "gemini-embedding-001", usage.Model)

	_, _, err = provider.IdentifyPhoto(t.Context(), []byte("image"), "image/jpeg")
	require.NoError(t, err)
	_, _, err = provider.Transcribe(t.Context(), []byte("audio"), "audio/m4a")
	require.NoError(t, err)

	assert.Equal(t, 1, direct.embedCalls)
	assert.Equal(t, 1, direct.photoCalls)
	assert.Equal(t, 1, direct.transcribeCalls)
}

func TestAgentGatewayProviderSendsServerOwnedClassificationHeaders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		call       func(AgentGatewayProvider) error
		capability string
		kind       string
		content    string
	}{
		{
			name: "identify text is structured JSON",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.IdentifyText(t.Context(), "apple")
				return err
			},
			capability: "identify_text",
			kind:       "json_api",
			content:    `{"guesses":[]}`,
		},
		{
			name: "decompose is structured JSON",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.Decompose(t.Context(), "salad")
				return err
			},
			capability: "decompose",
			kind:       "json_api",
			content:    `{"ingredients":[]}`,
		},
		{
			name: "coach is conversation",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.GenerateText(t.Context(), "system", "question")
				return err
			},
			capability: "coach",
			kind:       "conversation",
			content:    "answer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var gotHeader http.Header
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotHeader = r.Header.Clone()
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
					"id":     "completion-1",
					"object": "chat.completion",
					"choices": []map[string]any{{
						"index":         0,
						"message":       map[string]any{"role": "assistant", "content": tt.content},
						"finish_reason": "stop",
					}},
					"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
				}))
			}))
			t.Cleanup(server.Close)

			provider := NewAgentGatewayProvider(
				&recordingDirectProvider{},
				"gateway-key",
				server.URL+"/v1",
				"kora-auto",
			)
			require.NoError(t, tt.call(provider))

			assert.Equal(t, tt.capability, gotHeader.Get("X-Kora-Ai-Capability"))
			assert.Equal(t, tt.kind, gotHeader.Get("X-Kora-Ai-Context-Kind"))
			assert.Equal(t, "false", gotHeader.Get("X-Kora-Rtk-Applied"))
		})
	}
}
