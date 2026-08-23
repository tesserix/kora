package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// registryTimeout bounds one catalog lookup. It is deliberately short: a
// resolution sits in front of a user-facing answer, and a slow registry should
// fall back to the cached copy rather than spend the request's whole budget.
const registryTimeout = 3 * time.Second

// defaultTTL is how long a resolution stays fresh. Agent revisions are
// published by a reviewed PR, not continuously, so minutes are the right
// order — long enough that the registry sees roughly one request per agent per
// TTL, short enough that a republished agent takes effect without a deploy.
const defaultTTL = 5 * time.Minute

// ErrNotConfigured is returned by every Registry method when the registry is
// not configured. Callers treat it as "no agent available" and fall back.
var ErrNotConfigured = fmt.Errorf("agents: registry is not configured")

// Registry is a caching client for the Agentic Registry's catalog API. The
// zero value is unusable — build one with NewRegistry.
type Registry struct {
	baseURL string
	apiKey  string
	client  *http.Client
	cache   *cache
	observe func(agent string, result CacheResult)
}

// RegistryOptions configures a Registry. TTL and Client default when zero.
type RegistryOptions struct {
	BaseURL string
	APIKey  string
	TTL     time.Duration
	Client  *http.Client
	// Observe is called once per resolution with how it was served. It is the
	// only instrumentation seam, so this package imports no metrics code.
	Observe func(agent string, result CacheResult)
}

// NewRegistry builds a Registry. It returns nil when BaseURL or APIKey is
// empty, which is the signal the whole agent path is disabled — callers must
// nil-check, exactly as they already do for ai.Provider.
func NewRegistry(opts RegistryOptions) *Registry {
	if strings.TrimSpace(opts.BaseURL) == "" || strings.TrimSpace(opts.APIKey) == "" {
		return nil
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = defaultTTL
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: registryTimeout}
	}
	observe := opts.Observe
	if observe == nil {
		observe = func(string, CacheResult) {}
	}
	return &Registry{
		baseURL: strings.TrimSuffix(opts.BaseURL, "/"),
		apiKey:  opts.APIKey,
		client:  client,
		cache:   newCache(ttl),
		observe: observe,
	}
}

// Resolve returns the agent with its skills, tools, MCP servers and prompts
// already fetched, served from cache when fresh. An empty tag resolves the
// registry's current latest.
func (r *Registry) Resolve(ctx context.Context, name, tag string) (*ResolvedAgent, error) {
	if r == nil {
		return nil, ErrNotConfigured
	}

	key := cacheKey(name, tag)
	resolved, result, err := r.cache.load(ctx, key, func(ctx context.Context) (*ResolvedAgent, error) {
		return r.fetchResolved(ctx, name, tag)
	})
	r.observe(name, result)
	if err != nil {
		return nil, err
	}
	return resolved, nil
}

// Refresh drops the cached resolution for an agent so the next Resolve calls
// the registry. Publishing a new revision is the reason to call this.
func (r *Registry) Refresh(name, tag string) {
	if r == nil {
		return
	}
	r.cache.invalidate(cacheKey(name, tag))
}

// List returns the names of the Agent objects the caller can read. It is not
// cached: it exists for the diagnostics endpoint, not the request path.
func (r *Registry) List(ctx context.Context) ([]string, error) {
	if r == nil {
		return nil, ErrNotConfigured
	}

	// The catalog returns a bare array per collection, and the collection
	// route only matches with the trailing slash.
	var items []Object
	if err := r.get(ctx, "/v0/agents/", &items); err != nil {
		return nil, err
	}

	names := make([]string, 0, len(items))
	for _, o := range items {
		names = append(names, o.Metadata.Name)
	}
	return names, nil
}

func (r *Registry) fetchResolved(ctx context.Context, name, tag string) (*ResolvedAgent, error) {
	path := "/v0/agents/" + url.PathEscape(name) + "/resolved"
	if tag != "" {
		path = "/v0/agents/" + url.PathEscape(name) + "/" + url.PathEscape(tag) + "/resolved"
	}

	var resolved ResolvedAgent
	if err := r.get(ctx, path, &resolved); err != nil {
		return nil, err
	}
	if resolved.Agent.Metadata.Name == "" {
		return nil, fmt.Errorf("agents: registry returned no agent for %q", name)
	}
	return &resolved, nil
}

// get performs one authenticated catalog read. The API key is the same one
// the Agent Gateway accepts — the registry hashes it against the deploy-key
// digest registered for the Kora tenant.
func (r *Registry) get(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, registryTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.baseURL+path, nil)
	if err != nil {
		return fmt.Errorf("agents: build registry request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("agents: registry request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("agents: registry %s returned %d", path, resp.StatusCode)
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("agents: decode registry response: %w", err)
	}
	return nil
}
