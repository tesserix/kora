package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// resolvedFixture mirrors the shape the registry's /resolved endpoint returns
// for kora/nutrition-coach: skills declared inline on the card, tools as
// resolved objects.
func resolvedFixture() ResolvedAgent {
	return ResolvedAgent{
		Agent: Object{
			APIVersion: "registry.agentic.dev/v1alpha1",
			Kind:       "Agent",
			Metadata:   ObjectMeta{Name: "nutrition-coach", Namespace: "kora", Tag: "1.0.1", Digest: "sha256:abc"},
			Spec: map[string]any{
				"a2a": map[string]any{
					"url":                "http://kora-ai.agentgateway-system.svc.cluster.local:8080/a2a/v1/nutrition-coach",
					"preferredTransport": "JSONRPC",
				},
				"skills": []any{
					map[string]any{"id": "nutrition-guidance", "name": "Nutrition Guidance"},
					map[string]any{"id": "review-meal-plan", "name": "Review Meal Plan"},
				},
			},
		},
		Resolved: map[string][]Object{
			"tools": {{Kind: "Tool", Metadata: ObjectMeta{Name: "todays-totals"}}},
		},
	}
}

func registryServer(t *testing.T, calls *atomic.Int32, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q, want the configured bearer key", got)
		}
		calls.Add(1)
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		switch r.URL.Path {
		case "/v0/agents/":
			_ = json.NewEncoder(w).Encode([]Object{resolvedFixture().Agent})
		case "/v0/agents/nutrition-coach/resolved":
			_ = json.NewEncoder(w).Encode(resolvedFixture())
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestNewRegistryRequiresBaseURLAndKey(t *testing.T) {
	if got := NewRegistry(RegistryOptions{BaseURL: "https://aregistry.example", APIKey: ""}); got != nil {
		t.Fatal("NewRegistry with no key = non-nil, want nil so callers disable the agent path")
	}
	if got := NewRegistry(RegistryOptions{BaseURL: "", APIKey: "k"}); got != nil {
		t.Fatal("NewRegistry with no base URL = non-nil, want nil")
	}
}

func TestResolveReadsSkillsAndTools(t *testing.T) {
	var calls atomic.Int32
	srv := registryServer(t, &calls, http.StatusOK)
	defer srv.Close()

	r := NewRegistry(RegistryOptions{BaseURL: srv.URL, APIKey: "test-key"})
	resolved, err := r.Resolve(context.Background(), "nutrition-coach", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if !resolved.HasSkill("nutrition-guidance") {
		t.Errorf("HasSkill(nutrition-guidance) = false, want true — skills come from the card, not from this binary")
	}
	if got := resolved.Tools(); len(got) != 1 || got[0] != "todays-totals" {
		t.Errorf("Tools() = %v, want [todays-totals]", got)
	}
	// Only the path is used: the card advertises the in-cluster host, which
	// Kora cannot reach.
	if got := resolved.A2APath(); got != "/a2a/v1/nutrition-coach" {
		t.Errorf("A2APath() = %q, want the card's path with the host discarded", got)
	}
}

func TestResolveServesRepeatCallsFromCache(t *testing.T) {
	var calls atomic.Int32
	srv := registryServer(t, &calls, http.StatusOK)
	defer srv.Close()

	var results []CacheResult
	r := NewRegistry(RegistryOptions{
		BaseURL: srv.URL, APIKey: "test-key", TTL: time.Minute,
		Observe: func(_ string, result CacheResult) { results = append(results, result) },
	})

	for range 3 {
		if _, err := r.Resolve(context.Background(), "nutrition-coach", ""); err != nil {
			t.Fatalf("Resolve: %v", err)
		}
	}

	if got := calls.Load(); got != 1 {
		t.Errorf("registry calls = %d, want 1 — a fresh entry must not re-fetch", got)
	}
	want := []CacheResult{CacheMiss, CacheHit, CacheHit}
	for i, w := range want {
		if results[i] != w {
			t.Errorf("resolution %d served as %q, want %q", i, results[i], w)
		}
	}
}

func TestResolveCollapsesConcurrentMisses(t *testing.T) {
	var calls atomic.Int32
	srv := registryServer(t, &calls, http.StatusOK)
	defer srv.Close()

	r := NewRegistry(RegistryOptions{BaseURL: srv.URL, APIKey: "test-key", TTL: time.Minute})

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := r.Resolve(context.Background(), "nutrition-coach", ""); err != nil {
				t.Errorf("Resolve: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Errorf("registry calls = %d, want 1 — a cold cache must single-flight, not fan out", got)
	}
}

func TestResolveServesStaleWhenRegistryFails(t *testing.T) {
	var calls atomic.Int32
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(resolvedFixture())
	}))
	defer srv.Close()

	var last CacheResult
	r := NewRegistry(RegistryOptions{
		BaseURL: srv.URL, APIKey: "test-key", TTL: time.Millisecond,
		Observe: func(_ string, result CacheResult) { last = result },
	})

	if _, err := r.Resolve(context.Background(), "nutrition-coach", ""); err != nil {
		t.Fatalf("warm the cache: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	fail.Store(true)

	resolved, err := r.Resolve(context.Background(), "nutrition-coach", "")
	if err != nil {
		t.Fatalf("Resolve with a failing registry = %v, want the last good copy", err)
	}
	if last != CacheStale {
		t.Errorf("resolution served as %q, want %q", last, CacheStale)
	}
	if !resolved.HasSkill("nutrition-guidance") {
		t.Error("stale copy lost its skills")
	}
}

func TestResolveFailsWhenRegistryFailsWithNothingCached(t *testing.T) {
	var calls atomic.Int32
	srv := registryServer(t, &calls, http.StatusInternalServerError)
	defer srv.Close()

	r := NewRegistry(RegistryOptions{BaseURL: srv.URL, APIKey: "test-key"})
	if _, err := r.Resolve(context.Background(), "nutrition-coach", ""); err == nil {
		t.Fatal("Resolve = nil error, want a failure — there is no stale copy to serve")
	}
}

func TestResolveDoesNotSurfaceTheRegistryErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream-sensitive-detail"))
	}))
	defer srv.Close()

	r := NewRegistry(RegistryOptions{BaseURL: srv.URL, APIKey: "test-key"})
	_, err := r.Resolve(context.Background(), "nutrition-coach", "")
	if err == nil {
		t.Fatal("Resolve = nil error, want a Registry failure")
	}
	if strings.Contains(err.Error(), "upstream-sensitive-detail") {
		t.Fatalf("Resolve error exposed the Registry body: %v", err)
	}
}

func TestRefreshDropsTheCachedRevision(t *testing.T) {
	var calls atomic.Int32
	srv := registryServer(t, &calls, http.StatusOK)
	defer srv.Close()

	r := NewRegistry(RegistryOptions{BaseURL: srv.URL, APIKey: "test-key", TTL: time.Hour})
	ctx := context.Background()
	if _, err := r.Resolve(ctx, "nutrition-coach", ""); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	r.Refresh("nutrition-coach", "")
	if _, err := r.Resolve(ctx, "nutrition-coach", ""); err != nil {
		t.Fatalf("Resolve after Refresh: %v", err)
	}

	if got := calls.Load(); got != 2 {
		t.Errorf("registry calls = %d, want 2 — Refresh must force a re-read", got)
	}
}

func TestNilRegistryIsNotConfigured(t *testing.T) {
	var r *Registry
	if _, err := r.Resolve(context.Background(), "nutrition-coach", ""); err != ErrNotConfigured {
		t.Errorf("Resolve on a nil Registry = %v, want ErrNotConfigured", err)
	}
}
