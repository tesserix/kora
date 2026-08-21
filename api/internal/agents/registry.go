package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// maxRosterBytes caps the roster response. The registry lists tens of agents,
// not thousands, so anything larger is a misconfigured endpoint rather than a
// roster worth parsing.
const maxRosterBytes = 1 << 20

// defaultRegistryTTL matches the chart's AI_REGISTRY_TTL default. Agent cards
// change at review speed, not request speed, so a few minutes of staleness
// costs nothing and removes the registry from the hot path.
const defaultRegistryTTL = 5 * time.Minute

// Skill is a capability an agent declares in its card. Routing matches on
// these rather than on the agent's name, so adding an agent to the registry
// is enough to make Kora route to it.
type Skill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Examples    []string `json:"examples"`
}

// rosterAgent is the slice of an agent's registry envelope that routing needs.
type rosterAgent struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Skills []Skill `json:"skills"`
	} `json:"spec"`
}

// roster is one resolved view of the registry: which agents exist and what
// each one claims it can do.
type roster struct {
	agents  []rosterAgent
	fetched time.Time
}

// Registry resolves agent routing from the agentic registry. It is a Selector
// and an allowlist source — never a transport. Delegation still goes through
// GatewayClient, which reaches agents only via the configured gateway origin.
//
// Every failure path degrades rather than erroring: a stale roster is served
// when the registry is unreachable, and an empty one falls back to the
// deterministic keyword selector. A registry outage must not cost the user an
// answer Kora can still give.
type Registry struct {
	baseURL    url.URL
	apiKey     string
	ttl        time.Duration
	httpClient *http.Client

	mu     sync.RWMutex
	cached *roster

	// group collapses a cold-cache stampede into one upstream fetch.
	group singleflight.Group

	// observe reports cache outcomes for metrics; nil when unwired.
	observe func(result string)
}

// NewRegistry builds a Registry, returning nil when unconfigured so callers
// can nil-check it the way they nil-check a Delegator. An unset base URL is
// the supported way to run without registry routing.
func NewRegistry(baseURL, apiKey string, ttl time.Duration) (*Registry, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, nil
	}
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("agents: parse registry URL: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("agents: registry URL must be absolute HTTP(S)")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("agents: registry URL must not contain user info, query, or fragment")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("agents: registry API key is required")
	}
	if ttl <= 0 {
		ttl = defaultRegistryTTL
	}
	parsed.Path, parsed.RawPath = "", ""

	return &Registry{
		baseURL:    *parsed,
		apiKey:     apiKey,
		ttl:        ttl,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// AsSelector returns the Registry as a Selector, or an untyped nil when it is
// unconfigured. Returning r directly would box a nil *Registry into a non-nil
// interface, so callers checking `selector != nil` would wire routing that
// does not exist.
func (r *Registry) AsSelector() Selector {
	if r == nil {
		return nil
	}
	return r
}

// WithObserver wires cache-outcome reporting.
func (r *Registry) WithObserver(observe func(result string)) *Registry {
	if r != nil {
		r.observe = observe
	}
	return r
}

// SelectForQuestion routes by declared skill, falling back to the keyword
// selector whenever the registry cannot answer. A nil Registry is a valid
// unconfigured state, not an error.
func (r *Registry) SelectForQuestion(ctx context.Context, question string) Name {
	if r == nil {
		return SelectForQuestion(question)
	}
	current := r.load(ctx)
	if current == nil || len(current.agents) == 0 {
		return SelectForQuestion(question)
	}
	if name, ok := matchSkill(current.agents, question); ok {
		return name
	}
	return SelectForQuestion(question)
}

// Roster reports whether a name is an agent the registry currently publishes.
// This is what widens Delegate's allowlist beyond the two compiled-in names,
// and it is safe to do so for the same reason the compiled list is safe: both
// come from a reviewed control plane, never from request data.
func (r *Registry) Roster(ctx context.Context) func(Name) bool {
	if r == nil {
		return nil
	}
	current := r.load(ctx)
	if current == nil || len(current.agents) == 0 {
		return nil
	}
	known := make(map[Name]struct{}, len(current.agents))
	for _, agent := range current.agents {
		known[Name(agent.Metadata.Name)] = struct{}{}
	}
	return func(name Name) bool {
		_, ok := known[name]
		return ok
	}
}

// matchSkill picks the agent whose declared skills best cover the question.
// Scoring is deliberately simple and explainable: one point per distinct
// skill token the question mentions. A zero score means no opinion, which
// hands the decision back to the keyword selector rather than guessing.
func matchSkill(candidates []rosterAgent, question string) (Name, bool) {
	normalized := " " + strings.ToLower(strings.Join(strings.Fields(question), " ")) + " "

	var best Name
	bestScore := 0
	for _, agent := range candidates {
		score := 0
		for _, skill := range agent.Spec.Skills {
			for _, token := range skillTokens(skill) {
				if strings.Contains(normalized, " "+token+" ") {
					score++
				}
			}
		}
		if score > bestScore {
			best, bestScore = Name(agent.Metadata.Name), score
		}
	}
	return best, bestScore > 0
}

// skillTokens is the vocabulary a skill routes on: its tags plus the words of
// its id and name. Descriptions are excluded — they are prose written for
// humans and match almost any question.
func skillTokens(skill Skill) []string {
	var tokens []string
	for _, tag := range skill.Tags {
		if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" {
			tokens = append(tokens, tag)
		}
	}
	for _, field := range []string{skill.ID, skill.Name} {
		for _, word := range strings.FieldsFunc(strings.ToLower(field), func(r rune) bool {
			return r == '-' || r == '_' || r == ' '
		}) {
			if len(word) > 2 {
				tokens = append(tokens, word)
			}
		}
	}
	return tokens
}

// load returns a fresh roster, a stale one when the registry is unreachable,
// or nil when there is nothing cached and the fetch failed.
func (r *Registry) load(ctx context.Context) *roster {
	r.mu.RLock()
	cached := r.cached
	r.mu.RUnlock()

	if cached != nil && time.Since(cached.fetched) < r.ttl {
		r.report("hit")
		return cached
	}

	fetched, err, _ := r.group.Do("roster", func() (any, error) {
		return r.fetch(ctx)
	})
	if err != nil {
		if cached != nil {
			// Stale beats absent: the roster describes reviewed agents that
			// do not disappear because the registry had a bad minute.
			slog.WarnContext(ctx, "agents: registry unreachable, serving stale roster", "err", err, "age", time.Since(cached.fetched))
			r.report("stale")
			return cached
		}
		slog.WarnContext(ctx, "agents: registry unreachable, falling back to keyword routing", "err", err)
		r.report("error")
		return nil
	}

	current := fetched.(*roster)
	r.mu.Lock()
	r.cached = current
	r.mu.Unlock()
	r.report("miss")
	return current
}

func (r *Registry) report(result string) {
	if r.observe != nil {
		r.observe(result)
	}
}

func (r *Registry) fetch(ctx context.Context) (*roster, error) {
	endpoint := r.baseURL
	endpoint.Path = "/v0/agents/"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("agents: build registry request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agents: registry request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("agents: registry returned %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}

	var envelope struct {
		Items []rosterAgent `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRosterBytes)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("agents: decode registry roster: %w", err)
	}
	return &roster{agents: envelope.Items, fetched: time.Now()}, nil
}
