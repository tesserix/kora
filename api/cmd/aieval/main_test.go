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

func TestMintEvalTokenRequestsTheKoraAudience(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != "eval-client" || secret != "eval-secret" {
			t.Errorf("basic auth = %q %q %v", id, secret, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if got := r.PostForm.Get("grant_type"); got != "client_credentials" {
			t.Errorf("grant_type = %q", got)
		}
		if got := r.PostForm.Get("scope"); got != "openid urn:zitadel:iam:org:project:id:394926080202442797:aud" {
			t.Errorf("scope = %q", got)
		}
		_, _ = w.Write([]byte(`{"access_token":"h.p.s","token_type":"Bearer"}`))
	}))
	defer server.Close()

	token, err := mintEvalToken(t.Context(), server.URL, "394926080202442797", "eval-client", "eval-secret")
	if err != nil || token != "h.p.s" {
		t.Fatalf("token = %q, err = %v", token, err)
	}
}

func TestMintEvalTokenRefusesOpaqueTokensAndFailures(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"opaque token": {http.StatusOK, `{"access_token":"opaque"}`},
		"rejected":     {http.StatusUnauthorized, `{"error":"invalid_client"}`},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			if _, err := mintEvalToken(t.Context(), server.URL, "p", "c", "s"); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}
