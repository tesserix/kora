package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/auth"
)

func TestAgentGatewayProviderRoutesEveryCapabilityThroughTheLogicalModel(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		call       func(AgentGatewayProvider) error
		capability string
		kind       string
		path       string
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
			path:       "/v1/chat/completions",
			content:    `{"guesses":[]}`,
		},
		{
			name: "identify photo is multimodal JSON",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.IdentifyPhoto(t.Context(), []byte("image"), "image/jpeg")
				return err
			},
			capability: "identify_photo",
			kind:       "json_api",
			path:       "/v1/chat/completions",
			content:    `{"guesses":[]}`,
		},
		{
			name: "identify body composition is structured JSON",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.IdentifyBodyComposition(t.Context(), []byte("image"), "image/png")
				return err
			},
			capability: "identify_body_composition",
			kind:       "json_api",
			path:       "/v1/chat/completions",
			content:    `{"weight_kg":null,"body_fat_pct":null,"subcutaneous_fat_pct":null,"visceral_fat_rating":null,"skeletal_muscle_pct":null,"muscle_mass_kg":null,"body_water_pct":null,"protein_pct":null,"bone_mass_kg":null,"scale_bmr_kcal":null,"reading_date":null}`,
		},
		{
			name: "decompose is structured JSON",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.Decompose(t.Context(), "salad")
				return err
			},
			capability: "decompose",
			kind:       "json_api",
			path:       "/v1/chat/completions",
			content:    `{"ingredients":[]}`,
		},
		{
			name: "embedding is derived data",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.Embed(t.Context(), "apple")
				return err
			},
			capability: "embedding",
			kind:       "embedding",
			path:       "/v1/embeddings",
		},
		{
			name: "transcription is multimodal audio",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.Transcribe(t.Context(), []byte("audio"), "audio/m4a")
				return err
			},
			capability: "transcribe",
			kind:       "audio",
			path:       "/v1/chat/completions",
			content:    "spoken words",
		},
		{
			name: "coach is conversation",
			call: func(provider AgentGatewayProvider) error {
				_, _, err := provider.GenerateText(t.Context(), "system", "question")
				return err
			},
			capability: "coach",
			kind:       "conversation",
			path:       "/v1/chat/completions",
			content:    "answer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var gotHeader http.Header
			var gotPath string
			var gotModel string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotHeader = r.Header.Clone()
				gotPath = r.URL.Path
				var requestBody map[string]any
				require.NoError(t, json.NewDecoder(r.Body).Decode(&requestBody))
				gotModel, _ = requestBody["model"].(string)
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/embeddings" {
					require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
						"object": "list",
						"model":  "gemini-embedding-001",
						"data": []map[string]any{{
							"object": "embedding", "index": 0, "embedding": []float64{0.1, 0.2, 0.3},
						}},
						"usage": map[string]int{"prompt_tokens": 1, "total_tokens": 1},
					}))
					return
				}
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

			provider := NewAgentGatewayProvider("gateway-key", server.URL+"/v1", "kora-auto")
			require.NoError(t, tt.call(provider))

			assert.Equal(t, tt.path, gotPath)
			assert.Equal(t, "kora-auto", gotModel)
			assert.Equal(t, tt.capability, gotHeader.Get("X-Kora-Ai-Capability"))
			assert.Equal(t, tt.kind, gotHeader.Get("X-Kora-Ai-Context-Kind"))
			assert.Equal(t, "false", gotHeader.Get("X-Kora-Rtk-Applied"))
		})
	}
}

func TestAgentGatewayProviderDelegatesTheVerifiedEndUserIdentity(t *testing.T) {
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"id": "completion-1", "object": "chat.completion",
			"choices": []map[string]any{{
				"index": 0, "message": map[string]any{"role": "assistant", "content": "answer"},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
		}))
	}))
	t.Cleanup(server.Close)

	provider := NewAgentGatewayProvider("gateway-key", server.URL+"/v1", "kora-auto")
	ctx := auth.WithVerifiedToken(context.Background(), "firebase-user-token")
	_, _, err := provider.GenerateText(ctx, "system", "question")
	require.NoError(t, err)

	assert.Equal(t, "Bearer firebase-user-token", got.Get("X-Kora-End-User-Token"))
}
