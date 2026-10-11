package accuracy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type received struct {
	mu     sync.Mutex
	bodies []map[string]any
	auth   []string
}

func langfuse(t *testing.T, status int) (*httptest.Server, *received) {
	t.Helper()
	got := &received{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/public/scores", r.URL.Path)
		var body map[string]any
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		user, pass, _ := r.BasicAuth()
		got.mu.Lock()
		got.bodies = append(got.bodies, body)
		got.auth = append(got.auth, user+":"+pass)
		got.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func TestSendPostsEachScoreToTheTrace(t *testing.T) {
	srv, got := langfuse(t, http.StatusOK)
	client := NewClient(Config{Host: srv.URL, PublicKey: "pk", SecretKey: "sk", Environment: "production"})

	client.Send(context.Background(), []Score{
		{ID: "r-a", TraceID: "t1", Name: "capture.top1_correct", Value: 1, DataType: "BOOLEAN",
			Comment: "corrected", Metadata: map[string]string{"mode": "text"}},
		{ID: "r-b", TraceID: "t1", Name: "capture.selected_rank", Value: 2, DataType: "NUMERIC"},
	})
	require.NoError(t, client.Close(context.Background()))

	require.Len(t, got.bodies, 2)
	assert.Equal(t, []string{"pk:sk", "pk:sk"}, got.auth)
	first := got.bodies[0]
	assert.Equal(t, "r-a", first["id"])
	assert.Equal(t, "t1", first["traceId"])
	assert.Equal(t, "capture.top1_correct", first["name"])
	assert.Equal(t, 1.0, first["value"])
	assert.Equal(t, "BOOLEAN", first["dataType"])
	assert.Equal(t, "corrected", first["comment"])
	assert.Equal(t, "production", first["environment"])
	assert.Equal(t, map[string]any{"mode": "text"}, first["metadata"])
}

func TestSendReturnsBeforeASlowLangfuseAnswers(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	client := NewClient(Config{Host: srv.URL, PublicKey: "pk", SecretKey: "sk"})

	start := time.Now()
	client.Send(context.Background(), []Score{{ID: "a", TraceID: "t", Name: "n", DataType: "NUMERIC"}})

	assert.Less(t, time.Since(start), 100*time.Millisecond, "a log write must not wait on Langfuse")
}

func TestSendSurvivesARejectingLangfuse(t *testing.T) {
	srv, got := langfuse(t, http.StatusUnauthorized)
	client := NewClient(Config{Host: srv.URL, PublicKey: "pk", SecretKey: "wrong"})

	client.Send(context.Background(), []Score{{ID: "a", TraceID: "t", Name: "n", DataType: "NUMERIC"}})

	require.NoError(t, client.Close(context.Background()))
	assert.Len(t, got.bodies, 1)
}

func TestAClientWithoutKeysIsDisabled(t *testing.T) {
	assert.Nil(t, NewClient(Config{Host: "https://langfuse.example"}))
	var client *Client
	assert.NotPanics(t, func() {
		client.Send(context.Background(), []Score{{ID: "a"}})
		_ = client.Close(context.Background())
	})
}
