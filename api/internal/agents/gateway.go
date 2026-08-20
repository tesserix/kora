package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
)

const maxResponseBytes = 1 << 20

var (
	ErrUnknownAgent    = errors.New("unknown agent")
	ErrInvalidResponse = errors.New("invalid agent response")
)

type Result struct {
	Text  string
	Usage ai.Usage
}

type Delegator interface {
	Delegate(ctx context.Context, name Name, prompt string) (Result, error)
}

// GatewayClient invokes reviewed A2A agents only through the configured
// AgentGateway origin. It never accepts an agent-card URL from request data.
type GatewayClient struct {
	baseURL    url.URL
	apiKey     string
	httpClient *http.Client
	newID      func() string
}

func NewGatewayClient(modelBaseURL, apiKey string, timeout time.Duration) (*GatewayClient, error) {
	parsed, err := url.Parse(strings.TrimSpace(modelBaseURL))
	if err != nil {
		return nil, fmt.Errorf("agents: parse gateway URL: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("agents: gateway URL must be absolute HTTP(S)")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("agents: gateway URL must not contain user info, query, or fragment")
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	if path != "" && path != "/v1" {
		return nil, fmt.Errorf("agents: gateway URL path must be /v1 or empty")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("agents: gateway API key is required")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("agents: timeout must be positive")
	}
	parsed.Path = ""
	parsed.RawPath = ""

	return &GatewayClient{
		baseURL:    *parsed,
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: timeout},
		newID:      uuid.NewString,
	}, nil
}

type a2aRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      string        `json:"id"`
	Method  string        `json:"method"`
	Params  requestParams `json:"params"`
}

type requestParams struct {
	Message requestMessage `json:"message"`
}

type requestMessage struct {
	Role  string        `json:"role"`
	Parts []requestPart `json:"parts"`
}

type requestPart struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type a2aResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  *responseResult `json:"result"`
	Error   *responseError  `json:"error"`
}

type responseError struct {
	Code int `json:"code"`
}

type responseResult struct {
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
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	} `json:"metadata"`
}

func (c *GatewayClient) Delegate(ctx context.Context, name Name, prompt string) (result Result, err error) {
	result.Usage = ai.Usage{
		Provider: "agentgateway",
		Model:    string(name),
		CallType: "agent_delegate",
	}
	started := time.Now()
	defer func() {
		result.Usage.LatencyMs = int(time.Since(started).Milliseconds())
	}()

	if !name.reviewed() {
		return result, fmt.Errorf("agents: %w: %q", ErrUnknownAgent, name)
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return result, fmt.Errorf("agents: prompt is required")
	}

	requestID := c.newID()
	payload, err := json.Marshal(a2aRequest{
		JSONRPC: "2.0",
		ID:      requestID,
		Method:  "message/send",
		Params: requestParams{Message: requestMessage{
			Role:  "user",
			Parts: []requestPart{{Kind: "text", Text: prompt}},
		}},
	})
	if err != nil {
		return result, fmt.Errorf("agents: encode request: %w", err)
	}

	endpoint := c.baseURL
	endpoint.Path = "/a2a/v1/" + string(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return result, fmt.Errorf("agents: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kora-AI-Capability", "agent_delegate")
	if name == MealPlanner {
		req.Header.Set("X-Kora-AI-Context-Kind", "structured")
	} else {
		req.Header.Set("X-Kora-AI-Context-Kind", "conversation")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return result, fmt.Errorf("agents: gateway request: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return result, fmt.Errorf("agents: read gateway response: %w", err)
	}
	if len(body) > maxResponseBytes {
		return result, fmt.Errorf("agents: %w: response exceeds limit", ErrInvalidResponse)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return result, fmt.Errorf("agents: gateway returned HTTP %d", resp.StatusCode)
	}

	var decoded a2aResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return result, fmt.Errorf("agents: %w: decode JSON", ErrInvalidResponse)
	}
	if decoded.JSONRPC != "2.0" {
		return result, fmt.Errorf("agents: %w: unexpected JSON-RPC version", ErrInvalidResponse)
	}
	var responseID string
	if err := json.Unmarshal(decoded.ID, &responseID); err != nil || responseID != requestID {
		return result, fmt.Errorf("agents: %w: mismatched JSON-RPC id", ErrInvalidResponse)
	}
	if decoded.Error != nil {
		return result, fmt.Errorf("agents: A2A JSON-RPC error %d", decoded.Error.Code)
	}
	if decoded.Result == nil || decoded.Result.Status.State != "completed" {
		return result, fmt.Errorf("agents: %w: run did not complete", ErrInvalidResponse)
	}

	parts := make([]string, 0, len(decoded.Result.Artifacts))
	for _, artifact := range decoded.Result.Artifacts {
		for _, part := range artifact.Parts {
			if part.Kind == "text" && strings.TrimSpace(part.Text) != "" {
				parts = append(parts, strings.TrimSpace(part.Text))
			}
		}
	}
	if len(parts) == 0 {
		return result, fmt.Errorf("agents: %w: missing text artifact", ErrInvalidResponse)
	}
	text := strings.Join(parts, "\n")
	if name == MealPlanner {
		text, err = formatMealPlan(text)
		if err != nil {
			return result, err
		}
	}

	result.Text = text
	result.Usage.TokensIn = decoded.Result.Metadata.Usage.InputTokens
	result.Usage.TokensOut = decoded.Result.Metadata.Usage.OutputTokens
	return result, nil
}

type mealPlan struct {
	Summary string `json:"summary"`
	Days    []struct {
		Date  string `json:"date"`
		Meals []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"meals"`
	} `json:"days"`
}

func formatMealPlan(raw string) (string, error) {
	var plan mealPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		return "", fmt.Errorf("agents: %w: meal plan is not JSON", ErrInvalidResponse)
	}
	if strings.TrimSpace(plan.Summary) == "" || len(plan.Days) == 0 {
		return "", fmt.Errorf("agents: %w: meal plan is incomplete", ErrInvalidResponse)
	}
	lines := []string{strings.TrimSpace(plan.Summary)}
	for _, day := range plan.Days {
		if strings.TrimSpace(day.Date) == "" || len(day.Meals) == 0 {
			return "", fmt.Errorf("agents: %w: meal plan day is incomplete", ErrInvalidResponse)
		}
		lines = append(lines, "", day.Date)
		for _, meal := range day.Meals {
			if strings.TrimSpace(meal.Name) == "" || strings.TrimSpace(meal.Description) == "" {
				return "", fmt.Errorf("agents: %w: meal is incomplete", ErrInvalidResponse)
			}
			lines = append(lines, "• "+strings.TrimSpace(meal.Name)+" — "+strings.TrimSpace(meal.Description))
		}
	}
	return strings.Join(lines, "\n"), nil
}

var _ Delegator = (*GatewayClient)(nil)
