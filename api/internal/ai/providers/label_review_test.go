package providers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/labelocr"
)

func TestLabelReviewUsesAuthenticatedStrongerRouteAndNoInventedPortion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "read_label_review", r.Header.Get("X-Kora-AI-Capability"))
		require.Equal(t, "Bearer verified", r.Header.Get("X-Kora-End-User-Token"))
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "kora-auto", body["model"])
		format := body["response_format"].(map[string]any)["json_schema"].(map[string]any)
		properties := format["schema"].(map[string]any)["properties"].(map[string]any)
		for _, name := range []string{"basis", "serving_unit"} {
			property := properties[name].(map[string]any)
			if _, incompatible := property["enum"]; incompatible {
				http.Error(w, "nullable type arrays with enum are rejected by provider", http.StatusBadRequest)
				return
			}
			encoded, err := json.Marshal(property)
			require.NoError(t, err)
			if name == "basis" {
				require.JSONEq(t, `{"anyOf":[{"type":"string","enum":["per_100g","per_100ml","per_serving"]},{"type":"null"}]}`, string(encoded))
			} else {
				require.JSONEq(t, `{"anyOf":[{"type":"string","enum":["g","ml"]},{"type":"null"}]}`, string(encoded))
			}
		}
		w.Header().Set("Content-Type", "application/json")
		content := `{"basis":"per_100g","energy_kcal":200,"protein_g":null,"fat_g":null,"saturated_fat_g":null,"carbohydrate_g":null,"sugars_g":null,"fibre_g":null,"sodium_mg":null}`
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"model": "claude-sonnet-5-5", "choices": []any{map[string]any{"message": map[string]any{"content": content}}}, "usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 50}}))
	}))
	t.Cleanup(server.Close)
	reader := NewLabelReviewer("test-key", server.URL+"/v1")
	read, usage, err := reader.Review(auth.WithVerifiedToken(t.Context(), "verified"), []byte("image"), "image/png")
	require.NoError(t, err)
	require.JSONEq(t, `200`, string(read.Fields["per_100g.energy_kcal"].Value))
	require.NotContains(t, read.Fields, "consumed_amount")
	require.Equal(t, "claude-sonnet-5-5", usage.Model)
	require.Equal(t, 100, usage.TokensIn)
}

func TestLabelReviewReadsKilojouleOnlyPanels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		properties := body["response_format"].(map[string]any)["json_schema"].(map[string]any)["schema"].(map[string]any)["properties"].(map[string]any)
		if _, ok := properties["energy_kj"]; !ok {
			http.Error(w, "schema cannot read a kilojoule-only label", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"model":   "claude-sonnet-5-5",
			"choices": []any{map[string]any{"message": map[string]any{"content": `{"basis":"per_100g","energy_kcal":null,"energy_kj":1046,"protein_g":10,"fat_g":10,"carbohydrate_g":30}`}}},
		}))
	}))
	t.Cleanup(server.Close)
	read, _, err := NewLabelReviewer("test-key", server.URL+"/v1").Review(auth.WithVerifiedToken(t.Context(), "verified"), []byte("image"), "image/png")
	require.NoError(t, err)
	require.JSONEq(t, `1046`, string(read.Fields["per_100g.energy_kj"].Value))
	require.NotContains(t, read.Fields, "per_100g.energy_kcal", "the model must not calculate calories")
	label, err := labelocr.Check(read.Fields, read.Failures)
	require.NoError(t, err)
	require.InDelta(t, 250, *label.Per100.EnergyKcal, 0.001)
}

func TestLabelReviewRequiresVerifiedIdentityAndNeverRetriesProviderErrors(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(http.StatusServiceUnavailable) }))
	t.Cleanup(server.Close)
	reviewer := NewLabelReviewer("test-key", server.URL+"/v1")
	_, _, err := reviewer.Review(t.Context(), []byte("image"), "image/png")
	require.Error(t, err)
	require.Zero(t, calls)
	_, _, err = reviewer.Review(auth.WithVerifiedToken(t.Context(), "verified"), []byte("image"), "image/png")
	require.Error(t, err)
	require.Equal(t, 1, calls)
}

func TestLabelReviewRejectsAnUndeployedOrIncorrectModelRoute(t *testing.T) {
	for _, model := range []string{"gemini-3.5-flash", "claude-sonnet-4-5", "claude-sonnet-5-5-unapproved"} {
		t.Run(model, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"model": model, "choices": []any{map[string]any{"message": map[string]any{"content": `{"basis":"per_100g","energy_kcal":200}`}}}}))
			}))
			t.Cleanup(server.Close)
			_, _, err := NewLabelReviewer("test-key", server.URL+"/v1").Review(auth.WithVerifiedToken(t.Context(), "verified"), []byte("image"), "image/png")
			require.Error(t, err, "only the evaluated model may act as an independent review")
		})
	}
}
