package decide

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/auth"
)

func TestDecideUsesOnlyGatewayAndPreservesTypedAnswers(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/decisions", r.URL.Path)
		require.Equal(t, "Bearer gateway-test-key", r.Header.Get("Authorization"))
		require.Equal(t, "Bearer verified-test-token", r.Header.Get("X-Kora-End-User-Token"))
		require.Equal(t, "decide", r.Header.Get("X-Kora-AI-Capability"))
		var body struct {
			Model     string                     `json:"model"`
			State     json.RawMessage            `json:"state"`
			Questions map[string]json.RawMessage `json:"questions"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "kora-decide", body.Model)
		require.JSONEq(t, `{"amount":null}`, string(body.State))
		require.JSONEq(t, `{"type":"choice","instructions":"Choose next action","criteria":{"ask":"Amount missing","calculate":"Amount known"}}`, string(body.Questions["next"]))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"next":{"type":"choice","choice":"ask","confidence":0.9,"probabilities":{"ask":0.95,"calculate":0.05}},"known":{"type":"noul","noul":0.03}},"usage":{"input_tokens":400,"output_tokens":50}}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL+"/v1", "gateway-test-key", server.Client())
	require.NoError(t, err)
	ctx := auth.WithVerifiedToken(t.Context(), "verified-test-token")
	answer, err := client.Decide(ctx, json.RawMessage(`{"amount":null}`), map[string]Question{
		"next":  Choice{Instructions: "Choose next action", Criteria: map[string]string{"ask": "Amount missing", "calculate": "Amount known"}},
		"known": Noul{Instructions: "Is an amount known?"},
	})
	require.NoError(t, err)
	require.Equal(t, "ask", answer.Answers["next"].Choice)
	require.InDelta(t, .03, *answer.Answers["known"].Noul, .0001)
	require.Nil(t, answer.Answers["known"].Confidence)
	require.Equal(t, 400, answer.Usage.InputTokens)
	require.Equal(t, "jev-1.13.0", answer.Model)
}

func TestDecideRejectsInvalidInputBeforeNetwork(t *testing.T) {
	t.Parallel()
	client, err := NewClient("http://127.0.0.1:1/v1", "test-key", nil)
	require.NoError(t, err)
	ctx := auth.WithVerifiedToken(t.Context(), "verified")
	for name, tc := range map[string]struct {
		state     string
		questions map[string]Question
	}{
		"numeric state":      {"123", map[string]Question{"known": Noul{"Known?"}}},
		"nil choice":         {`{}`, map[string]Question{"next": (*Choice)(nil)}},
		"empty questions":    {`{}`, nil},
		"empty instructions": {`{}`, map[string]Question{"known": Noul{}}},
		"null state":         {`null`, map[string]Question{"known": Noul{"Known?"}}},
		"oversize state":     {`"` + strings.Repeat("x", MaxRequestBytes) + `"`, map[string]Question{"known": Noul{"Known?"}}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := client.Decide(ctx, json.RawMessage(tc.state), tc.questions)
			require.ErrorIs(t, err, ErrInvalid)
		})
	}
}

func TestGatewayOriginCannotBeProviderOrRedirect(t *testing.T) {
	t.Parallel()
	for _, base := range []string{"https://api.typesafe.ai", "https://example.com", "http://localhost/v1?token=private", "http://user:pass@localhost/v1", "file:///v1"} {
		_, err := NewClient(base, "test-key", nil)
		require.ErrorIs(t, err, ErrInvalid)
	}
	client, err := NewClient("", "", nil)
	require.NoError(t, err)
	require.Nil(t, client)
	_, err = client.Decide(t.Context(), nil, nil)
	require.ErrorIs(t, err, ErrNotConfigured)
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	t.Cleanup(target.Close)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(source.Close)
	client, err = NewClient(source.URL, "test-key", source.Client())
	require.NoError(t, err)
	_, err = client.Decide(auth.WithVerifiedToken(t.Context(), "verified"), json.RawMessage(`{}`), map[string]Question{"known": Noul{"Known?"}})
	require.ErrorIs(t, err, ErrUnavailable)
	require.False(t, redirected)
}

func TestResponseValidationRejectsUnsafeDecisions(t *testing.T) {
	t.Parallel()
	valid := `{"model":"jev-1.13.0","answers":{"next":{"type":"choice","choice":"ask","confidence":0.9,"probabilities":{"ask":0.95,"calculate":0.05}}},"usage":{"input_tokens":400,"output_tokens":50}}`
	for name, raw := range map[string]string{
		"missing answers":   strings.Replace(valid, `"next":{`, `"other":{`, 1),
		"wrong answer type": strings.Replace(valid, `"type":"choice"`, `"type":"noul"`, 1),
		"unknown option":    strings.Replace(valid, `"choice":"ask"`, `"choice":"invent"`, 1),
		"distribution":      strings.Replace(valid, `"ask":0.95`, `"ask":0.5`, 1),
		"confidence":        strings.Replace(valid, `"confidence":0.9`, `"confidence":2`, 1),
		"usage":             strings.Replace(valid, `"input_tokens":400`, `"input_tokens":-1`, 1),
		"missing usage":     strings.Replace(valid, `,"usage":{"input_tokens":400,"output_tokens":50}`, ``, 1),
		"null probability":  strings.Replace(strings.Replace(valid, `"ask":0.95`, `"ask":1`, 1), `"calculate":0.05`, `"calculate":null`, 1),
		"model alias":       strings.Replace(valid, `jev-1.13.0`, `jev-latest`, 1),
		"trailing data":     valid + ` {}`,
		"too large":         strings.Repeat("x", MaxResponseBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(raw)) }))
			t.Cleanup(server.Close)
			client, err := NewClient(server.URL, "test-key", server.Client())
			require.NoError(t, err)
			_, err = client.Decide(auth.WithVerifiedToken(t.Context(), "verified"), json.RawMessage(`{}`), map[string]Question{"next": Choice{"Next?", map[string]string{"ask": "Missing", "calculate": "Known"}}})
			require.ErrorIs(t, err, ErrInvalid)
		})
	}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("credential=private document=private")
}

func TestDecideRequiresIdentityAndRedactsTransportFailures(t *testing.T) {
	t.Parallel()
	client, err := NewClient("http://127.0.0.1/v1", "test-key", &http.Client{Transport: failingTransport{}})
	require.NoError(t, err)
	_, err = client.Decide(t.Context(), json.RawMessage(`{}`), map[string]Question{"known": Noul{"Known?"}})
	require.ErrorIs(t, err, ErrIdentity)
	ctx := auth.WithVerifiedToken(t.Context(), "verified")
	_, err = client.Decide(ctx, json.RawMessage(`{}`), map[string]Question{"known": Noul{"Known?"}})
	require.ErrorIs(t, err, ErrUnavailable)
	require.NotContains(t, err.Error(), "private")
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	_, err = client.Decide(ctx, json.RawMessage(`{}`), map[string]Question{"known": Noul{"Known?"}})
	require.ErrorIs(t, err, context.Canceled)
}

func TestScorePreservesFractionalValueAndItsLegend(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"quality":{"type":"score","score":1.05,"legend":{"0":"Poor","1":"Fair","2":"Good"},"probabilities":{"0":0,"1":0.95,"2":0.05},"confidence":0.92}},"usage":{"input_tokens":300,"output_tokens":20}}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "test-key", server.Client())
	require.NoError(t, err)
	result, err := client.Decide(auth.WithVerifiedToken(t.Context(), "verified"), json.RawMessage(`"synthetic"`), map[string]Question{"quality": Score{"Assess quality", []string{"Poor", "Fair", "Good"}}})
	require.NoError(t, err)
	require.InDelta(t, 1.05, *result.Answers["quality"].Score, .0001)
}

type deadlineTransport struct{ t *testing.T }

func (d deadlineTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	deadline, ok := r.Context().Deadline()
	require.True(d.t, ok)
	require.LessOrEqual(d.t, time.Until(deadline), Deadline)
	return nil, context.DeadlineExceeded
}

func TestEveryCallHasABoundedDeadline(t *testing.T) {
	t.Parallel()
	client, err := NewClient("http://127.0.0.1", "test-key", &http.Client{Transport: deadlineTransport{t}})
	require.NoError(t, err)
	_, err = client.Decide(auth.WithVerifiedToken(t.Context(), "verified"), json.RawMessage(`{}`), map[string]Question{"known": Noul{"Known?"}})
	require.ErrorIs(t, err, context.DeadlineExceeded)
}
