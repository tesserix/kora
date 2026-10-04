package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/aitrace"
	"github.com/tesserix/kora/api/internal/auth"
)

// runTimeout bounds one agent run. The published coach budget is 45s of model
// time (ai-agents definitions.go), so this leaves headroom for transport
// without letting a wedged agent hold a request open indefinitely.
const runTimeout = 60 * time.Second

// MaxPromptRunes mirrors the agents' max_prompt_chars, which Python counts in
// characters. Callers fit their prompt first; Send only trims as a last resort.
const MaxPromptRunes = 12_000

// Usage is the token accounting an agent reports for a run, mapped onto the
// same shape ai.Usage records so a run bills like any other model call.
type Usage struct {
	InputTokens  int
	OutputTokens int
	CachedTokens int
	Estimated    bool
}

// Run is the outcome of one A2A call: the agent's text plus enough provenance
// to explain which revision produced it.
type Run struct {
	RunID string
	Agent string
	// DisplayName is what the user is shown as the answer's author. It is
	// carried separately from Agent because Agent is the registry id that
	// metrics and logs are labelled by, and that must stay stable even if
	// the published display name changes.
	DisplayName string
	Skill       string
	State       string
	Text        string
	Digest      string
	Usage       Usage
}

// Gateway calls agents over A2A JSON-RPC through the Agent Gateway. It holds
// no agent list of its own — every route comes from a resolved card.
type Gateway struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

// NewGateway builds a Gateway, returning nil when unconfigured so callers
// nil-check it the same way they nil-check Registry.
//
// Only the ORIGIN of baseURL is kept. AI_GATEWAY_BASE_URL ends in /v1 because
// the model path speaks the OpenAI protocol, while A2A is routed at /a2a/v1/
// on the same gateway — joining the two would produce /v1/a2a/v1/<agent> and
// 404 on every run.
func NewGateway(baseURL, apiKey string, client *http.Client) *Gateway {
	origin := originOf(baseURL)
	if origin == "" || strings.TrimSpace(apiKey) == "" {
		return nil
	}
	if client == nil {
		client = &http.Client{Timeout: runTimeout}
	}
	return &Gateway{baseURL: origin, apiKey: apiKey, client: client}
}

// originOf reduces a URL to scheme://host[:port], returning "" when it has no
// usable origin.
func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

var agentNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Send runs one message against the agent addressed by the resolved card.
// The card names the agent; the gateway supplies the host and the key.
func (g *Gateway) Send(ctx context.Context, resolved *ResolvedAgent, prompt string) (Run, error) {
	if g == nil {
		return Run{}, ErrNotConfigured
	}
	if resolved == nil {
		return Run{}, fmt.Errorf("agents: send: no resolved agent")
	}

	path := resolved.A2APath()
	if path == "" {
		return Run{}, fmt.Errorf("agents: %s publishes no a2a url", resolved.Agent.Metadata.Name)
	}
	// A registry card must not be able to steer a user's prompt to any other gateway route.
	name := resolved.Agent.Metadata.Name
	if !agentNamePattern.MatchString(name) || path != "/a2a/v1/"+name {
		return Run{}, fmt.Errorf("agents: %q publishes a2a path %q, want /a2a/v1/<name>", name, path)
	}
	if transport := resolved.Transport(); transport != "JSONRPC" {
		return Run{}, fmt.Errorf("agents: %s wants transport %s, which Kora does not speak", resolved.Agent.Metadata.Name, transport)
	}
	if utf8.RuneCountInString(prompt) > MaxPromptRunes {
		prompt = FirstRunes(prompt, MaxPromptRunes)
		slog.WarnContext(ctx, "agents: prompt trimmed to the a2a limit", "agent", resolved.Agent.Metadata.Name)
	}

	requestID := uuid.NewString()
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"method":  "message/send",
		"params": map[string]any{
			"message": map[string]any{
				"role":  "user",
				"parts": []map[string]any{{"kind": "text", "text": prompt}},
			},
		},
	})
	if err != nil {
		return Run{}, fmt.Errorf("agents: encode a2a request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return Run{}, fmt.Errorf("agents: build a2a request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+g.apiKey)
	req.Header.Set("Content-Type", "application/json")
	aitrace.Inject(ctx, req.Header)
	if token, ok := auth.VerifiedTokenFromContext(ctx); ok {
		req.Header.Set("X-Kora-End-User-Token", "Bearer "+token)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return Run{}, fmt.Errorf("agents: a2a request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Run{}, fmt.Errorf("agents: a2a %s returned %d", path, resp.StatusCode)
	}

	var envelope a2aResponse
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return Run{}, fmt.Errorf("agents: decode a2a response: %w", err)
	}
	if envelope.Error != nil {
		return Run{}, fmt.Errorf("agents: a2a error %d", envelope.Error.Code)
	}

	text := envelope.text()
	if text == "" {
		return Run{}, fmt.Errorf("agents: %s returned no text part", resolved.Agent.Metadata.Name)
	}

	return Run{
		RunID:       envelope.Result.ID,
		Agent:       resolved.Agent.Metadata.Name,
		DisplayName: resolved.DisplayName(),
		State:       envelope.Result.Status.State,
		Text:        text,
		Digest:      resolved.Agent.Metadata.Digest,
		Usage: Usage{
			InputTokens:  envelope.Result.Metadata.Usage.InputTokens,
			OutputTokens: envelope.Result.Metadata.Usage.OutputTokens,
			CachedTokens: envelope.Result.Metadata.Usage.CachedTokens,
			Estimated:    envelope.Result.Metadata.Usage.Estimated,
		},
	}, nil
}

type a2aResponse struct {
	Result struct {
		ID     string `json:"id"`
		Status struct {
			State string `json:"state"`
		} `json:"status"`
		Artifacts []struct {
			Parts []struct {
				Kind string `json:"kind"`
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"artifacts"`
		Metadata struct {
			Usage struct {
				InputTokens  int  `json:"input_tokens"`
				OutputTokens int  `json:"output_tokens"`
				CachedTokens int  `json:"cached_tokens"`
				Estimated    bool `json:"estimated"`
			} `json:"usage"`
		} `json:"metadata"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// text concatenates every text part across artifacts, which is how a
// multi-artifact answer is meant to be read back.
func (r a2aResponse) text() string {
	var b strings.Builder
	for _, artifact := range r.Result.Artifacts {
		for _, part := range artifact.Parts {
			if part.Kind != "text" || part.Text == "" {
				continue
			}
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(part.Text)
		}
	}
	return strings.TrimSpace(b.String())
}

// FirstRunes returns at most n whole characters from the start of s.
func FirstRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}
