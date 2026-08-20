package agents

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSelectForQuestion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		question string
		want     Name
	}{
		{name: "general nutrition", question: "How can I add more protein to lunch?", want: NutritionCoach},
		{name: "explicit meal plan", question: "Please make me a 3 day meal plan", want: MealPlanner},
		{name: "weekly menu", question: "Can you plan my weekly menu?", want: MealPlanner},
		{name: "single meal advice", question: "What should I eat with lunch?", want: NutritionCoach},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			require.Equal(t, tt.want, SelectForQuestion(tt.question))
		})
	}
}

func TestGatewayClientDelegatesOnlyThroughConfiguredGateway(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		require.Equal(t, "Bearer gateway-key", r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("X-User-ID"))
		require.Empty(t, r.Header.Get("X-Tenant-ID"))
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.Contains(t, string(body), `"method":"message/send"`)
		require.Contains(t, string(body), `"text":"trusted prompt"`)

		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"request-1","result":{"id":"run-1","status":{"state":"completed"},"artifacts":[{"parts":[{"kind":"text","text":"agent answer"}]}],"metadata":{"usage":{"input_tokens":12,"output_tokens":5}}}}`)
	}))
	t.Cleanup(server.Close)

	client, err := NewGatewayClient(server.URL+"/v1", "gateway-key", 2*time.Second)
	require.NoError(t, err)
	client.newID = func() string { return "request-1" }

	result, err := client.Delegate(t.Context(), NutritionCoach, "trusted prompt")

	require.NoError(t, err)
	require.Equal(t, "/a2a/v1/nutrition-coach", gotPath)
	require.Equal(t, "agent answer", result.Text)
	require.Equal(t, 12, result.Usage.TokensIn)
	require.Equal(t, 5, result.Usage.TokensOut)
	require.Equal(t, "agentgateway", result.Usage.Provider)
	require.Equal(t, "nutrition-coach", result.Usage.Model)
}

func TestGatewayClientFormatsMealPlannerOutput(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"request-1","result":{"id":"run-1","status":{"state":"completed"},"artifacts":[{"parts":[{"kind":"text","text":"{\"summary\":\"A practical plan\",\"days\":[{\"date\":\"2026-08-21\",\"meals\":[{\"name\":\"Lunch\",\"description\":\"Lentil bowl\"}]}]}"}] }]}}`)
	}))
	t.Cleanup(server.Close)

	client, err := NewGatewayClient(server.URL, "gateway-key", 2*time.Second)
	require.NoError(t, err)
	client.newID = func() string { return "request-1" }

	result, err := client.Delegate(t.Context(), MealPlanner, "plan meals")

	require.NoError(t, err)
	require.Contains(t, result.Text, "A practical plan")
	require.Contains(t, result.Text, "2026-08-21")
	require.Contains(t, result.Text, "Lunch — Lentil bowl")
	require.NotContains(t, result.Text, `"summary"`)
}

func TestGatewayClientRejectsUnknownAgentBeforeNetwork(t *testing.T) {
	t.Parallel()

	client, err := NewGatewayClient("https://gateway.invalid/v1", "gateway-key", time.Second)
	require.NoError(t, err)

	_, err = client.Delegate(t.Context(), Name("unreviewed-agent"), "prompt")

	require.ErrorIs(t, err, ErrUnknownAgent)
}

func TestGatewayClientPropagatesCancellation(t *testing.T) {
	t.Parallel()

	client, err := NewGatewayClient("https://gateway.invalid/v1", "gateway-key", time.Second)
	require.NoError(t, err)
	client.httpClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	result, err := client.Delegate(ctx, NutritionCoach, "prompt")

	require.Error(t, err)
	require.True(t, errors.Is(err, context.Canceled))
	require.Equal(t, "agentgateway", result.Usage.Provider)
	require.Equal(t, "nutrition-coach", result.Usage.Model)
}

func TestGatewayClientRejectsFailedJSONRPCResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"request-1","error":{"code":-32603,"message":"private upstream detail"}}`)
	}))
	t.Cleanup(server.Close)
	client, err := NewGatewayClient(server.URL+"/v1", "gateway-key", time.Second)
	require.NoError(t, err)
	client.newID = func() string { return "request-1" }

	_, err = client.Delegate(t.Context(), NutritionCoach, "prompt")

	require.Error(t, err)
	require.Contains(t, err.Error(), "-32603")
	require.NotContains(t, err.Error(), "private upstream detail")
}

func TestGatewayClientRejectsMismatchedJSONRPCID(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"different-request","result":{"status":{"state":"completed"},"artifacts":[{"parts":[{"kind":"text","text":"answer"}]}]}}`)
	}))
	t.Cleanup(server.Close)
	client, err := NewGatewayClient(server.URL+"/v1", "gateway-key", time.Second)
	require.NoError(t, err)
	client.newID = func() string { return "request-1" }

	_, err = client.Delegate(t.Context(), NutritionCoach, "prompt")

	require.ErrorIs(t, err, ErrInvalidResponse)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}
