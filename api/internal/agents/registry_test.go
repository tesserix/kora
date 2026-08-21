package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// rosterFixture is the shape /v0/agents/ returns: an envelope of agent cards,
// each declaring the skills it implements.
func rosterFixture() map[string]any {
	return map[string]any{"items": []any{
		map[string]any{
			"metadata": map[string]any{"name": "nutrition-coach"},
			"spec": map[string]any{"skills": []any{
				map[string]any{"id": "nutrition-guidance", "tags": []any{"protein", "calories"}},
			}},
		},
		map[string]any{
			"metadata": map[string]any{"name": "diet-planner"},
			"spec": map[string]any{"skills": []any{
				map[string]any{"id": "weight-loss-planning", "tags": []any{"weight", "kilos"}},
			}},
		},
	}}
}

func registryServer(t *testing.T, hits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			atomic.AddInt32(hits, 1)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer registry-key" {
			t.Errorf("Authorization = %q, want the deploy key", got)
		}
		if r.URL.Path != "/v0/agents/" {
			t.Errorf("path = %q, want the roster path", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(rosterFixture())
	}))
}

func newTestRegistry(t *testing.T, baseURL string, ttl time.Duration) *Registry {
	t.Helper()
	r, err := NewRegistry(baseURL, "registry-key", ttl)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	if r == nil {
		t.Fatal("NewRegistry = nil, want a configured registry")
	}
	return r
}

// The whole point of the registry: an agent nobody compiled in becomes
// routable purely by publishing a card that declares the matching skill.
func TestSelectForQuestionRoutesToAnAgentTheRegistryPublishes(t *testing.T) {
	srv := registryServer(t, nil)
	defer srv.Close()

	r := newTestRegistry(t, srv.URL, time.Minute)

	got := r.SelectForQuestion(context.Background(), "help me lose 10 kilos over the next month")
	if got != Name("diet-planner") {
		t.Errorf("SelectForQuestion = %q, want diet-planner from the published skill", got)
	}
}

func TestSelectForQuestionFallsBackToKeywordsWhenNoSkillMatches(t *testing.T) {
	srv := registryServer(t, nil)
	defer srv.Close()

	r := newTestRegistry(t, srv.URL, time.Minute)

	got := r.SelectForQuestion(context.Background(), "put together a meal plan for me")
	if got != MealPlanner {
		t.Errorf("SelectForQuestion = %q, want the keyword table's meal-planner", got)
	}
}

// A registry outage must cost routing quality, never an answer.
func TestSelectForQuestionFallsBackWhenTheRegistryIsDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	r := newTestRegistry(t, srv.URL, time.Minute)

	if got := r.SelectForQuestion(context.Background(), "how is my protein today?"); got != NutritionCoach {
		t.Errorf("SelectForQuestion = %q, want the keyword default", got)
	}
}

// The roster describes reviewed agents, which do not stop existing because
// the registry had a bad minute — so a stale roster beats no roster.
func TestAStaleRosterSurvivesARegistryOutage(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(rosterFixture())
	}))
	defer srv.Close()

	// A zero TTL is clamped to the default, so use a tiny one to expire.
	r := newTestRegistry(t, srv.URL, time.Nanosecond)

	if got := r.SelectForQuestion(context.Background(), "lose 10 kilos"); got != Name("diet-planner") {
		t.Fatalf("warm-up SelectForQuestion = %q, want diet-planner", got)
	}

	fail.Store(true)
	if got := r.SelectForQuestion(context.Background(), "lose 10 kilos"); got != Name("diet-planner") {
		t.Errorf("SelectForQuestion after outage = %q, want the stale roster's diet-planner", got)
	}
}

func TestConcurrentLookupsCollapseIntoOneFetch(t *testing.T) {
	var hits int32
	srv := registryServer(t, &hits)
	defer srv.Close()

	r := newTestRegistry(t, srv.URL, time.Minute)

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.SelectForQuestion(context.Background(), "lose 10 kilos")
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("registry fetches = %d, want 1 — a cold cache must not stampede", got)
	}
}

func TestRosterWidensTheDelegationAllowlist(t *testing.T) {
	srv := registryServer(t, nil)
	defer srv.Close()

	r := newTestRegistry(t, srv.URL, time.Minute)
	published := r.Roster(context.Background())
	if published == nil {
		t.Fatal("Roster = nil, want the published agents")
	}
	if !published("diet-planner") {
		t.Error("diet-planner is published but not allowed")
	}
	if published("attacker-agent") {
		t.Error("an unpublished agent must never be allowed")
	}
}

// The allowlist may only ever widen. If the registry is unreachable the
// compiled-in agents must still work, and nothing else may slip through.
func TestDelegateFallsBackToTheCompiledAllowlistWithoutARegistry(t *testing.T) {
	client, err := NewGatewayClient("https://gateway.example/v1", "gw-key", time.Second)
	if err != nil {
		t.Fatalf("NewGatewayClient: %v", err)
	}
	ctx := context.Background()

	if !client.allows(ctx, NutritionCoach) {
		t.Error("nutrition-coach must remain allowed with no registry")
	}
	if client.allows(ctx, "diet-planner") {
		t.Error("an unpublished agent must not be allowed with no registry")
	}
}

func TestNewRegistryReportsNilWhenUnconfigured(t *testing.T) {
	r, err := NewRegistry("", "key", time.Minute)
	if err != nil || r != nil {
		t.Fatalf("NewRegistry with no base URL = (%v, %v), want (nil, nil)", r, err)
	}
	if r.AsSelector() != nil {
		t.Error("AsSelector on a nil Registry must be an untyped nil, not a boxed nil")
	}
	if got := r.SelectForQuestion(context.Background(), "how is my protein?"); got != NutritionCoach {
		t.Errorf("nil Registry SelectForQuestion = %q, want the keyword default", got)
	}
}

func TestNewRegistryRejectsAURLWithNoOrigin(t *testing.T) {
	if _, err := NewRegistry("aregistry.tesserix.app", "key", time.Minute); err == nil {
		t.Error("NewRegistry with no scheme = nil error, want a rejection")
	}
}
