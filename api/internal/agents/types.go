// Package agents resolves Kora's agents, skills and tools from the Agentic
// Registry at request time and runs them over A2A through the Agent Gateway.
//
// Nothing here is compiled into the binary: an agent's identity, its skills,
// its tools and its transport all come from the registry, so publishing a new
// revision changes behaviour without a Kora deploy. Resolution is cached with
// a TTL and falls back to the last good copy when the registry is unreachable,
// so a registry outage degrades to stale composition rather than to no agent.
package agents

import "strings"

// Object is the registry's universal envelope, shared by every kind (Agent,
// Skill, Tool, Prompt). spec is left as a free-form map because Kora only
// reads a handful of fields and must not break when the registry adds more.
type Object struct {
	APIVersion string         `json:"apiVersion"`
	Kind       string         `json:"kind"`
	Metadata   ObjectMeta     `json:"metadata"`
	Spec       map[string]any `json:"spec,omitempty"`
}

// ObjectMeta is the identity subset Kora reads. Digest and Ref are the
// registry's server-computed attestation fields, carried so a run can be
// traced back to the exact revision that produced it.
type ObjectMeta struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Tag       string            `json:"tag,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	Digest    string            `json:"digest,omitempty"`
	Ref       string            `json:"ref,omitempty"`
}

// ResolvedAgent is the registry's /resolved response: an Agent plus the
// skills, tools, MCP servers and prompts its spec references, already fetched.
type ResolvedAgent struct {
	Agent      Object              `json:"agent"`
	Resolved   map[string][]Object `json:"resolved"`
	Unresolved []UnresolvedRef     `json:"unresolved,omitempty"`
}

// UnresolvedRef is a reference the registry could not resolve. Kora surfaces
// these rather than silently running a half-composed agent.
type UnresolvedRef struct {
	Kind   string `json:"kind"`
	Ref    string `json:"ref"`
	Reason string `json:"reason"`
}

// Skill is one capability an agent declares, as published in the registry —
// either inline in the agent's card or as a referenced Skill object.
type Skill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags,omitempty"`
}

// Skills returns the agent's skills, preferring resolved Skill objects and
// falling back to the inline spec.skills list on the agent card. An agent that
// declares neither has no skills, which the selector treats as "not routable".
func (r ResolvedAgent) Skills() []Skill {
	if out := skillsFromObjects(r.Resolved["skills"]); len(out) > 0 {
		return out
	}
	return skillsFromSpec(r.Agent.Spec["skills"])
}

// Tools returns the names of the tools the agent may call. Kora does not
// execute these itself — they are what the agent pulls from the registry — but
// it records them so a run can be explained after the fact.
func (r ResolvedAgent) Tools() []string {
	objects := r.Resolved["tools"]
	out := make([]string, 0, len(objects))
	for _, o := range objects {
		if o.Metadata.Name != "" {
			out = append(out, o.Metadata.Name)
		}
	}
	return out
}

// HasSkill reports whether the agent declares the given skill id.
func (r ResolvedAgent) HasSkill(id string) bool {
	for _, s := range r.Skills() {
		if s.ID == id {
			return true
		}
	}
	return false
}

// DisplayName is the agent's human-readable name, for showing the user who
// answered. spec.title is what the published cards actually carry; the other
// two are accepted because the schema allows them. An agent published without
// any of them still reads as "Nutrition Coach" rather than "nutrition-coach".
func (r ResolvedAgent) DisplayName() string {
	for _, key := range []string{"title", "displayName", "name"} {
		if v, _ := r.Agent.Spec[key].(string); strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return titleCase(r.Agent.Metadata.Name)
}

// titleCase turns a registry name into words: "nutrition-coach" reads as
// "Nutrition Coach".
func titleCase(name string) string {
	fields := strings.FieldsFunc(name, func(r rune) bool { return r == '-' || r == '_' || r == '.' })
	for i, f := range fields {
		fields[i] = strings.ToUpper(f[:1]) + f[1:]
	}
	return strings.Join(fields, " ")
}

// A2APath is the agent's A2A endpoint path, taken from spec.a2a.url. Only the
// path is used: the host in the card is the in-cluster service, while Kora
// reaches the same route through its configured gateway base URL.
func (r ResolvedAgent) A2APath() string {
	a2a, _ := r.Agent.Spec["a2a"].(map[string]any)
	url, _ := a2a["url"].(string)
	return pathOf(url)
}

// Transport is the card's preferred transport, defaulting to JSONRPC — the
// only transport the gateway currently serves.
func (r ResolvedAgent) Transport() string {
	a2a, _ := r.Agent.Spec["a2a"].(map[string]any)
	if t, _ := a2a["preferredTransport"].(string); t != "" {
		return t
	}
	return "JSONRPC"
}

func skillsFromObjects(objects []Object) []Skill {
	out := make([]Skill, 0, len(objects))
	for _, o := range objects {
		s := Skill{ID: o.Metadata.Name}
		if id, _ := o.Spec["id"].(string); id != "" {
			s.ID = id
		}
		s.Name, _ = o.Spec["name"].(string)
		s.Description, _ = o.Spec["description"].(string)
		s.Tags = stringsFrom(o.Spec["tags"])
		if s.ID != "" {
			out = append(out, s)
		}
	}
	return out
}

func skillsFromSpec(raw any) []Skill {
	entries, _ := raw.([]any)
	out := make([]Skill, 0, len(entries))
	for _, e := range entries {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		if id == "" {
			continue
		}
		name, _ := m["name"].(string)
		description, _ := m["description"].(string)
		out = append(out, Skill{ID: id, Name: name, Description: description, Tags: stringsFrom(m["tags"])})
	}
	return out
}

func stringsFrom(raw any) []string {
	entries, _ := raw.([]any)
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if s, ok := e.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}
