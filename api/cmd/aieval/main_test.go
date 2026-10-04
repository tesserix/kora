package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/tesserix/kora/api/internal/aieval"
)

func TestEvaluateWithoutAnAcceptedBaselineCannotPass(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; evaluation uses the real database-backed resolver")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/public/dataset-items":
			_, _ = w.Write([]byte(`{"data":[{"id":"egg","status":"ACTIVE","input":{"phrase":"egg"},"expectedOutput":{"name":"Egg"}}],"meta":{"totalPages":1}}`))
		case "/api/public/v2/datasets/kora-capture-text":
			_, _ = w.Write([]byte(`{"name":"kora-capture-text","metadata":{}}`))
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"{\"guesses\":[]}"}}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("AI_GATEWAY_BASE_URL", server.URL+"/v1")
	t.Setenv("AI_GATEWAY_API_KEY", "test-key")
	t.Setenv("KORA_EVAL_END_USER_TOKEN", "test-token")
	t.Setenv("KORA_AI_TRACE_ENDPOINT", "")
	code := evaluate(t.Context(), aieval.NewClient(server.URL, "pk", "sk"), "kora-capture-text", "test", false)
	if code != exitBroken {
		t.Fatalf("exit code = %d, want %d for a missing accepted baseline", code, exitBroken)
	}
}
