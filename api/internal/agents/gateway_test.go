package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/kora/api/internal/auth"
)

// a2aServer answers one message/send the way kora_agents.api does, and records
// the request it received so the wire contract can be asserted.
func a2aServer(t *testing.T, capture *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer gw-key" {
			t.Errorf("Authorization = %q, want the gateway key", got)
		}
		if r.URL.Path != "/a2a/v1/nutrition-coach" {
			t.Errorf("path = %q, want the card's a2a path", r.URL.Path)
		}

		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		*capture = body

		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      body["id"],
			"result": map[string]any{
				"id":     "run-1",
				"status": map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{
					"parts": []any{map[string]any{"kind": "text", "text": "You have logged 17.4g of protein."}},
				}},
				"metadata": map[string]any{
					"usage": map[string]any{"input_tokens": 120, "output_tokens": 40, "estimated": false},
				},
			},
		})
	}))
}

func TestSendSpeaksTheAgentsA2AContract(t *testing.T) {
	var got map[string]any
	srv := a2aServer(t, &got)
	defer srv.Close()

	g := NewGateway(srv.URL, "gw-key", nil)
	resolved := resolvedFixture()

	run, err := g.Send(context.Background(), &resolved, "CONTEXT:\nprotein 17.4g\n\nQUESTION: how am I doing?")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	if got["method"] != "message/send" {
		t.Errorf("method = %v, want message/send", got["method"])
	}
	params := got["params"].(map[string]any)["message"].(map[string]any)
	if params["role"] != "user" {
		t.Errorf("role = %v, want user", params["role"])
	}
	part := params["parts"].([]any)[0].(map[string]any)
	if part["kind"] != "text" || !strings.Contains(part["text"].(string), "QUESTION:") {
		t.Errorf("part = %v, want one text part carrying the grounded prompt", part)
	}

	if run.Text != "You have logged 17.4g of protein." {
		t.Errorf("Text = %q, want the artifact's text part", run.Text)
	}
	if run.State != "completed" || run.RunID != "run-1" {
		t.Errorf("run = %+v, want the agent's state and run id", run)
	}
	if run.Usage.InputTokens != 120 || run.Usage.OutputTokens != 40 {
		t.Errorf("Usage = %+v, want the tokens the agent reported", run.Usage)
	}
	if run.Digest != "sha256:abc" {
		t.Errorf("Digest = %q, want the resolved revision's digest", run.Digest)
	}
}

func TestSendDelegatesTheVerifiedEndUserIdentity(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Kora-End-User-Token")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": "1",
			"result": map[string]any{
				"id": "run-1", "status": map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{
					"parts": []any{map[string]any{"kind": "text", "text": "answer"}},
				}},
			},
		})
	}))
	defer srv.Close()

	g := NewGateway(srv.URL, "gw-key", nil)
	resolved := resolvedFixture()
	ctx := auth.WithVerifiedToken(context.Background(), "firebase-user-token")
	_, err := g.Send(ctx, &resolved, "question")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotToken != "Bearer firebase-user-token" {
		t.Fatalf("X-Kora-End-User-Token = %q, want delegated Firebase token", gotToken)
	}
}

func TestSendSurfacesAJSONRPCError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      "1",
			"error":   map[string]any{"code": -32000, "message": "agent execution failed"},
		})
	}))
	defer srv.Close()

	g := NewGateway(srv.URL, "gw-key", nil)
	resolved := resolvedFixture()
	if _, err := g.Send(context.Background(), &resolved, "hi"); err == nil {
		t.Fatal("Send = nil error, want the agent's JSON-RPC error surfaced")
	}
}

func TestSendDoesNotSurfaceTheA2AHTTPErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream-sensitive-detail"))
	}))
	defer srv.Close()

	g := NewGateway(srv.URL, "gw-key", nil)
	resolved := resolvedFixture()
	_, err := g.Send(context.Background(), &resolved, "hi")
	if err == nil {
		t.Fatal("Send = nil error, want an A2A failure")
	}
	if strings.Contains(err.Error(), "upstream-sensitive-detail") {
		t.Fatalf("Send error exposed the A2A HTTP body: %v", err)
	}
}

func TestSendDoesNotSurfaceTheA2AJSONRPCErrorMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      "1",
			"error":   map[string]any{"code": -32000, "message": "upstream-sensitive-detail"},
		})
	}))
	defer srv.Close()

	g := NewGateway(srv.URL, "gw-key", nil)
	resolved := resolvedFixture()
	_, err := g.Send(context.Background(), &resolved, "hi")
	if err == nil {
		t.Fatal("Send = nil error, want a JSON-RPC failure")
	}
	if strings.Contains(err.Error(), "upstream-sensitive-detail") {
		t.Fatalf("Send error exposed the A2A JSON-RPC message: %v", err)
	}
}

func TestSendRejectsAnUnsupportedTransport(t *testing.T) {
	resolved := resolvedFixture()
	resolved.Agent.Spec["a2a"].(map[string]any)["preferredTransport"] = "GRPC"

	g := NewGateway("https://agentgateway.example", "gw-key", nil)
	_, err := g.Send(context.Background(), &resolved, "hi")
	if err == nil || !strings.Contains(err.Error(), "GRPC") {
		t.Fatalf("Send with a GRPC card = %v, want a transport error naming it", err)
	}
}

func TestNilGatewayIsNotConfigured(t *testing.T) {
	var g *Gateway
	resolved := resolvedFixture()
	if _, err := g.Send(context.Background(), &resolved, "hi"); err != ErrNotConfigured {
		t.Errorf("Send on a nil Gateway = %v, want ErrNotConfigured", err)
	}
}

// AI_GATEWAY_BASE_URL carries the OpenAI /v1 suffix for the model path. A2A is
// routed at /a2a/v1/ on the same gateway, so keeping the suffix would address
// /v1/a2a/v1/<agent> and 404 every run.
func TestSendIgnoresTheModelPathOnTheGatewayBaseURL(t *testing.T) {
	var got map[string]any
	srv := a2aServer(t, &got)
	defer srv.Close()

	g := NewGateway(srv.URL+"/v1", "gw-key", nil)
	resolved := resolvedFixture()

	if _, err := g.Send(context.Background(), &resolved, "hi"); err != nil {
		t.Fatalf("Send against a /v1 base URL: %v", err)
	}
}

func TestNewGatewayRejectsAURLWithNoOrigin(t *testing.T) {
	if g := NewGateway("kora-ai.svc:8080", "gw-key", nil); g != nil {
		t.Error("NewGateway with no scheme = non-nil, want nil")
	}
}

func TestSendOnlyCallsTheAgentsOwnA2ARoute(t *testing.T) {
	tests := []struct {
		name, agent, url string
	}{
		{"foreign route", "nutrition-coach", "http://kora-ai.svc:8080/v1/chat/completions"},
		{"traversal", "nutrition-coach", "http://kora-ai.svc:8080/a2a/v1/nutrition-coach/../meal-planner"},
		{"encoded traversal", "nutrition-coach", "http://kora-ai.svc:8080/a2a/v1/nutrition-coach/%2e%2e/meal-planner"},
		{"another agent", "nutrition-coach", "http://kora-ai.svc:8080/a2a/v1/meal-planner"},
		{"suffix", "nutrition-coach", "/a2a/v1/nutrition-coach/extra"},
		{"query", "nutrition-coach", "/a2a/v1/nutrition-coach?route=admin"},
		{"unsafe agent name", "../admin", "/a2a/v1/../admin"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer srv.Close()

			resolved := resolvedFixture()
			resolved.Agent.Metadata.Name = tt.agent
			resolved.Agent.Spec["a2a"].(map[string]any)["url"] = tt.url

			_, err := NewGateway(srv.URL, "gw-key", nil).Send(context.Background(), &resolved, "hello")
			if err == nil {
				t.Fatal("Send = nil error, want the card's route rejected")
			}
			if calls != 0 {
				t.Fatalf("gateway calls = %d, want none before the route is validated", calls)
			}
		})
	}
}
