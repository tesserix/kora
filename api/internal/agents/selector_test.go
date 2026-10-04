package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// twoAgentRegistry publishes a planner, a coach and the plan supervisor with
// the skills ai-agents declares, so routing has to choose on skill rather than
// on a name Kora knows.
func twoAgentRegistry(t *testing.T) *httptest.Server {
	t.Helper()

	coach := resolvedFixture()
	planner := ResolvedAgent{
		Agent: Object{
			Kind:     "Agent",
			Metadata: ObjectMeta{Name: "meal-planner", Namespace: "kora", Tag: "1.0.0"},
			Spec: map[string]any{
				"a2a":    map[string]any{"url": "http://kora-ai.svc:8080/a2a/v1/meal-planner"},
				"skills": []any{map[string]any{"id": "plan-meals"}},
			},
		},
	}

	supervisor := ResolvedAgent{
		Agent: Object{
			Kind:     "Agent",
			Metadata: ObjectMeta{Name: "plan-supervisor", Namespace: "kora", Tag: "1.0.2"},
			Spec: map[string]any{
				"a2a":    map[string]any{"url": "http://kora-ai.svc:8080/a2a/v1/plan-supervisor"},
				"skills": []any{map[string]any{"id": "review-meal-plan"}},
			},
		},
	}

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/agents/":
			_ = json.NewEncoder(w).Encode([]Object{planner.Agent, coach.Agent, supervisor.Agent})
		case "/v0/agents/nutrition-coach/resolved":
			_ = json.NewEncoder(w).Encode(coach)
		case "/v0/agents/meal-planner/resolved":
			_ = json.NewEncoder(w).Encode(planner)
		case "/v0/agents/plan-supervisor/resolved":
			_ = json.NewEncoder(w).Encode(supervisor)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestReviewedAgentForSkillMatchesThePilotPolicy(t *testing.T) {
	tests := []struct {
		skill string
		agent string
		ok    bool
	}{
		{skill: "nutrition-guidance", agent: "nutrition-coach", ok: true},
		{skill: "review-meal-plan", agent: "plan-supervisor", ok: true},
		{skill: "plan-meals", agent: "meal-planner", ok: true},
		{skill: "arbitrary-tool-use", ok: false},
	}

	for _, tt := range tests {
		t.Run(tt.skill, func(t *testing.T) {
			agent, ok := reviewedAgentForSkill(tt.skill)
			if agent != tt.agent || ok != tt.ok {
				t.Fatalf("reviewedAgentForSkill(%q) = (%q, %t), want (%q, %t)", tt.skill, agent, ok, tt.agent, tt.ok)
			}
		})
	}
}

func TestRunRoutesOnTheSkillTheRegistryPublishes(t *testing.T) {
	registrySrv := twoAgentRegistry(t)
	defer registrySrv.Close()

	var calledPath string
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": body["id"],
			"result": map[string]any{
				"id":        "run-1",
				"status":    map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{"parts": []any{map[string]any{"kind": "text", "text": "ok"}}}},
			},
		})
	}))
	defer gatewaySrv.Close()

	var observed []string
	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway(gatewaySrv.URL, "gw-key", nil),
		func(agent, skill, outcome string) { observed = append(observed, agent+"/"+skill+"/"+outcome) },
	)

	run, err := c.Run(context.Background(), "nutrition-guidance", "hello")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if run.Agent != "nutrition-coach" {
		t.Errorf("Agent = %q, want the agent that declares the skill", run.Agent)
	}
	if calledPath != "/a2a/v1/nutrition-coach" {
		t.Errorf("gateway path = %q, want the coach's card path", calledPath)
	}
	if run.Skill != "nutrition-guidance" {
		t.Errorf("Skill = %q, want the requested skill recorded on the run", run.Skill)
	}
	if len(observed) != 1 || observed[0] != "nutrition-coach/nutrition-guidance/ok" {
		t.Errorf("observed = %v, want one ok run attributed to the coach", observed)
	}
}

func TestRunSendsPlanReviewToThePlanSupervisor(t *testing.T) {
	registrySrv := twoAgentRegistry(t)
	defer registrySrv.Close()

	var calledPath string
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": body["id"],
			"result": map[string]any{
				"id":        "run-1",
				"status":    map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{"parts": []any{map[string]any{"kind": "text", "text": "reviewed"}}}},
			},
		})
	}))
	defer gatewaySrv.Close()

	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway(gatewaySrv.URL, "gw-key", nil),
		nil,
	)

	run, err := c.Run(context.Background(), "review-meal-plan", "DRAFT PLAN: {}")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if run.Agent != "plan-supervisor" || calledPath != "/a2a/v1/plan-supervisor" {
		t.Errorf("review ran on %q via %q, want plan-supervisor via its card path", run.Agent, calledPath)
	}
}

func TestRunIgnoresAnUnreviewedAgentThatClaimsAReviewedSkill(t *testing.T) {
	coach := resolvedFixture()
	rogue := ResolvedAgent{
		Agent: Object{
			Kind:     "Agent",
			Metadata: ObjectMeta{Name: "a-rogue-coach", Namespace: "kora", Tag: "1.0.0"},
			Spec: map[string]any{
				"a2a":    map[string]any{"url": "http://rogue.svc:8080/a2a/v1/a-rogue-coach"},
				"skills": []any{map[string]any{"id": "nutrition-guidance"}},
			},
		},
	}
	registrySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/agents/":
			_ = json.NewEncoder(w).Encode([]Object{rogue.Agent, coach.Agent})
		case "/v0/agents/a-rogue-coach/resolved":
			_ = json.NewEncoder(w).Encode(rogue)
		case "/v0/agents/nutrition-coach/resolved":
			_ = json.NewEncoder(w).Encode(coach)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer registrySrv.Close()

	var calledPath string
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": body["id"],
			"result": map[string]any{
				"id":        "run-1",
				"status":    map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{"parts": []any{map[string]any{"kind": "text", "text": "ok"}}}},
			},
		})
	}))
	defer gatewaySrv.Close()

	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway(gatewaySrv.URL, "gw-key", nil),
		nil,
	)

	run, err := c.Run(context.Background(), "nutrition-guidance", "hello")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if run.Agent != "nutrition-coach" {
		t.Errorf("Agent = %q, want the reviewed nutrition-coach", run.Agent)
	}
	if calledPath != "/a2a/v1/nutrition-coach" {
		t.Errorf("gateway path = %q, want only the reviewed coach route", calledPath)
	}
}

func TestRunFailsWhenNoPublishedAgentDeclaresTheSkill(t *testing.T) {
	registrySrv := twoAgentRegistry(t)
	defer registrySrv.Close()

	var observed []string
	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway("https://agentgateway.example", "gw-key", nil),
		func(agent, skill, outcome string) { observed = append(observed, agent+"/"+skill+"/"+outcome) },
	)

	_, err := c.Run(context.Background(), "barcode-lookup", "hello")
	if err == nil || !strings.Contains(err.Error(), "barcode-lookup") {
		t.Fatalf("Run for an unpublished skill = %v, want an error naming the skill", err)
	}
	if len(observed) != 1 || !strings.HasSuffix(observed[0], "/unrouted") {
		t.Errorf("observed = %v, want the run recorded as unrouted", observed)
	}
}

func TestRunRejectsAnAgentWithUnresolvedRegistryReferences(t *testing.T) {
	resolved := resolvedFixture()
	resolved.Unresolved = []UnresolvedRef{{
		Kind:   "MCPServer",
		Ref:    "kora-nutrition",
		Reason: "not found",
	}}
	registrySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/agents/":
			_ = json.NewEncoder(w).Encode([]Object{resolved.Agent})
		case "/v0/agents/nutrition-coach/resolved":
			_ = json.NewEncoder(w).Encode(resolved)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer registrySrv.Close()

	gatewayCalls := 0
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		gatewayCalls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer gatewaySrv.Close()

	var observed []string
	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway(gatewaySrv.URL, "gw-key", nil),
		func(agent, skill, outcome string) { observed = append(observed, agent+"/"+skill+"/"+outcome) },
	)

	_, err := c.Run(context.Background(), "nutrition-guidance", "hello")
	if err == nil || !strings.Contains(err.Error(), "MCPServer/kora-nutrition") {
		t.Fatalf("Run with an unresolved MCP reference = %v, want a fail-closed error naming the reference", err)
	}
	if gatewayCalls != 0 {
		t.Fatalf("gateway calls = %d, want none for a partially resolved agent", gatewayCalls)
	}
	if len(observed) != 1 || observed[0] != "nutrition-coach/nutrition-guidance/unresolved" {
		t.Errorf("observed = %v, want the rejected run attributed as unresolved", observed)
	}
}

func TestCatalogReportsWhatIsPublishedRightNow(t *testing.T) {
	registrySrv := twoAgentRegistry(t)
	defer registrySrv.Close()

	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway("https://agentgateway.example", "gw-key", nil),
		nil,
	)

	catalog, err := c.Catalog(context.Background())
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	if len(catalog) != 3 {
		t.Fatalf("catalog has %d agents, want 3", len(catalog))
	}
	// Sorted by name, so meal-planner comes first.
	if catalog[0].Name != "meal-planner" || catalog[0].Skills[0] != "plan-meals" {
		t.Errorf("catalog[0] = %+v, want the planner and its skill", catalog[0])
	}
	if catalog[1].Tools[0] != "todays-totals" {
		t.Errorf("catalog[1].Tools = %v, want the coach's resolved tool", catalog[1].Tools)
	}
}

func TestNewCoordinatorNeedsBothHalves(t *testing.T) {
	registry := NewRegistry(RegistryOptions{BaseURL: "https://aregistry.example", APIKey: "k"})
	if c := NewCoordinator(registry, nil, nil); c != nil {
		t.Error("NewCoordinator without a gateway = non-nil, want nil so the caller falls back")
	}
	if c := NewCoordinator(nil, NewGateway("https://gw.example", "k", nil), nil); c != nil {
		t.Error("NewCoordinator without a registry = non-nil, want nil")
	}
}

func TestDisplayName_PrefersThePublishedNameThenTitleCasesTheID(t *testing.T) {
	// spec.title is what the live registry's cards carry.
	published := ResolvedAgent{Agent: Object{
		Metadata: ObjectMeta{Name: "nutrition-coach"},
		Spec:     map[string]any{"title": "Kora Nutrition Coach"},
	}}
	if got := published.DisplayName(); got != "Kora Nutrition Coach" {
		t.Fatalf("published display name: got %q", got)
	}

	// An agent published without one must still read as words, not as its id.
	bare := ResolvedAgent{Agent: Object{Metadata: ObjectMeta{Name: "meal-planner"}}}
	if got := bare.DisplayName(); got != "Meal Planner" {
		t.Fatalf("fallback display name: got %q", got)
	}
}
