package agents

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/tesserix/kora/api/internal/aitrace"
)

// Coordinator resolves and runs the reviewed Kora agent for a capability. The
// Registry supplies composition; it does not grant a newly published agent
// authority to receive Kora traffic.
type Coordinator struct {
	registry *Registry
	gateway  *Gateway
	observe  func(agent, skill, outcome string)

	mu      sync.RWMutex
	names   []string
	namesAt time.Time
	namesTT time.Duration
}

// NewCoordinator returns nil unless both the registry and the gateway are
// configured — a half-configured agent path is worse than none, because it
// would fail per request instead of falling back once at startup.
func NewCoordinator(r *Registry, g *Gateway, observe func(agent, skill, outcome string)) *Coordinator {
	if r == nil || g == nil {
		return nil
	}
	if observe == nil {
		observe = func(string, string, string) {}
	}
	return &Coordinator{registry: r, gateway: g, observe: observe, namesTT: defaultTTL}
}

// Available reports whether the agent path can be attempted at all.
func (c *Coordinator) Available() bool { return c != nil }

// Run resolves an agent that declares skill and sends it prompt. The returned
// Run carries the skill so a caller can log which capability actually served
// the answer.
func (c *Coordinator) Run(ctx context.Context, skill, prompt string) (Run, error) {
	if c == nil {
		return Run{}, ErrNotConfigured
	}
	ctx, span := aitrace.Start(ctx, "agent.run", attribute.String("kora.agent.skill", skill))
	defer span.End()

	resolved, err := c.agentForSkill(ctx, skill)
	if err != nil {
		c.finish(span, "", skill, "unrouted")
		return Run{}, err
	}

	name := resolved.Agent.Metadata.Name
	span.SetAttributes(
		attribute.String("kora.agent.name", name),
		attribute.String("kora.agent.tag", resolved.Agent.Metadata.Tag),
	)
	if len(resolved.Unresolved) > 0 {
		c.finish(span, name, skill, "unresolved")
		return Run{}, fmt.Errorf(
			"agents: %s has unresolved registry references: %s",
			name,
			summarize(resolved.Unresolved),
		)
	}

	run, err := c.gateway.Send(ctx, resolved, prompt)
	if err != nil {
		c.finish(span, name, skill, "error")
		return Run{}, err
	}
	run.Skill = skill

	c.finish(span, name, skill, outcomeFor(run.State))
	return run, nil
}

func (c *Coordinator) finish(span trace.Span, agent, skill, outcome string) {
	span.SetAttributes(attribute.String("kora.agent.outcome", outcome))
	if outcome != "ok" {
		span.SetStatus(codes.Error, outcome)
	}
	c.observe(agent, skill, outcome)
}

// Resolve exposes one agent's resolved composition for diagnostics.
func (c *Coordinator) Resolve(ctx context.Context, name string) (*ResolvedAgent, error) {
	if c == nil {
		return nil, ErrNotConfigured
	}
	return c.registry.Resolve(ctx, name, "")
}

// Catalog returns every readable agent with the skills and tools it currently
// declares. It is the answer to "what can Kora's agents do right now", read
// live from the registry rather than from anything in this binary.
func (c *Coordinator) Catalog(ctx context.Context) ([]AgentSummary, error) {
	if c == nil {
		return nil, ErrNotConfigured
	}

	names, err := c.agentNames(ctx)
	if err != nil {
		return nil, err
	}

	out := make([]AgentSummary, 0, len(names))
	for _, name := range names {
		resolved, err := c.registry.Resolve(ctx, name, "")
		if err != nil {
			slog.WarnContext(ctx, "agents: catalog skipped an agent", "agent", name, "err", err)
			continue
		}
		skills := resolved.Skills()
		ids := make([]string, 0, len(skills))
		for _, s := range skills {
			ids = append(ids, s.ID)
		}
		out = append(out, AgentSummary{
			Name:   name,
			Tag:    resolved.Agent.Metadata.Tag,
			Digest: resolved.Agent.Metadata.Digest,
			Skills: ids,
			Tools:  resolved.Tools(),
		})
	}
	return out, nil
}

// AgentSummary is one agent as the registry currently describes it.
type AgentSummary struct {
	Name   string   `json:"name"`
	Tag    string   `json:"tag,omitempty"`
	Digest string   `json:"digest,omitempty"`
	Skills []string `json:"skills"`
	Tools  []string `json:"tools"`
}

// agentForSkill resolves only the agent Kora reviewed for skill. KAI-03 will
// move this policy into a signed, digest-pinned product bundle; until then the
// small pilot allowlist is deliberately compiled with the product.
func (c *Coordinator) agentForSkill(ctx context.Context, skill string) (*ResolvedAgent, error) {
	name, ok := reviewedAgentForSkill(skill)
	if !ok {
		return nil, fmt.Errorf("agents: no reviewed agent is approved for skill %q", skill)
	}

	resolved, err := c.registry.Resolve(ctx, name, "")
	if err != nil {
		return nil, fmt.Errorf("agents: resolve reviewed agent %q for skill %q: %w", name, skill, err)
	}
	if !resolved.HasSkill(skill) {
		return nil, fmt.Errorf("agents: reviewed agent %q does not declare skill %q", name, skill)
	}
	return resolved, nil
}

func reviewedAgentForSkill(skill string) (string, bool) {
	switch skill {
	case "nutrition-guidance":
		return "nutrition-coach", true
	case "review-meal-plan":
		return "plan-supervisor", true
	case "plan-meals":
		return "meal-planner", true
	default:
		return "", false
	}
}

// agentNames lists the readable agents, cached on the same TTL as a
// resolution. Without this every route would spend a catalog round trip
// before the one that actually matters.
func (c *Coordinator) agentNames(ctx context.Context) ([]string, error) {
	c.mu.RLock()
	fresh := time.Since(c.namesAt) < c.namesTT && len(c.names) > 0
	names := c.names
	c.mu.RUnlock()
	if fresh {
		return names, nil
	}

	listed, err := c.registry.List(ctx)
	if err != nil {
		if len(names) > 0 {
			// Same stale-on-error contract as a resolution: an unreachable
			// registry keeps serving the agents we already knew about.
			return names, nil
		}
		return nil, err
	}
	sort.Strings(listed)

	c.mu.Lock()
	c.names, c.namesAt = listed, time.Now()
	c.mu.Unlock()
	return listed, nil
}

// outcomeFor maps an agent's terminal state onto the outcome label the rest of
// Kora's metrics use.
func outcomeFor(state string) string {
	switch strings.ToLower(state) {
	case "completed", "succeeded", "success":
		return "ok"
	case "":
		return "other"
	default:
		return state
	}
}

func summarize(refs []UnresolvedRef) string {
	parts := make([]string, 0, len(refs))
	for _, r := range refs {
		parts = append(parts, r.Kind+"/"+r.Ref)
	}
	return strings.Join(parts, ",")
}
