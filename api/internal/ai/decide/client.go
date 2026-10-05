// Package decide makes bounded, typed decisions through Kora's private gateway.
package decide

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tesserix/kora/api/internal/aitrace"
	"github.com/tesserix/kora/api/internal/auth"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

const (
	Deadline         = 1500 * time.Millisecond
	MaxRequestBytes  = 16000
	MaxResponseBytes = 64000
	MaxQuestions     = 16
	ModelAlias       = "kora-decide"
)

var (
	ErrNotConfigured = errors.New("decision client not configured")
	ErrIdentity      = errors.New("decision requires verified user identity")
	ErrInvalid       = errors.New("invalid decision contract")
	ErrUnavailable   = errors.New("decision unavailable")
	identifier       = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)
	modelVersion     = regexp.MustCompile(`^jev-[0-9]+\.[0-9]+\.[0-9]+$`)
)

// Question is a reviewed Choice, Score or Noul, not instructions from a document.
type Question interface{ wire() (questionWire, error) }

type Choice struct {
	Instructions string
	Criteria     map[string]string
}
type Score struct {
	Instructions string
	Criteria     []string
}
type Noul struct{ Instructions string }
type questionWire struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}

func (q Choice) wire() (questionWire, error) {
	if len(q.Criteria) < 2 || len(q.Criteria) > 255 {
		return questionWire{}, ErrInvalid
	}
	for id, desc := range q.Criteria {
		if !identifier.MatchString(id) || len(desc) > 2000 {
			return questionWire{}, ErrInvalid
		}
	}
	return questionWire{"choice", q.Instructions, q.Criteria}, nil
}
func (q Score) wire() (questionWire, error) {
	if len(q.Criteria) < 2 || len(q.Criteria) > 255 {
		return questionWire{}, ErrInvalid
	}
	for _, desc := range q.Criteria {
		if strings.TrimSpace(desc) == "" || len(desc) > 2000 {
			return questionWire{}, ErrInvalid
		}
	}
	return questionWire{"score", q.Instructions, q.Criteria}, nil
}
func (q Noul) wire() (questionWire, error) {
	return questionWire{Type: "noul", Instructions: q.Instructions}, nil
}

type Answer struct {
	Type          string             `json:"type"`
	Choice        string             `json:"choice,omitempty"`
	Score         *float64           `json:"score,omitempty"`
	Noul          *float64           `json:"noul,omitempty"`
	Confidence    *float64           `json:"confidence,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	Legend        map[string]string  `json:"legend,omitempty"`
}
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}
type Result struct {
	Model   string            `json:"model"`
	Answers map[string]Answer `json:"answers"`
	Usage   Usage             `json:"usage"`
}

// Client has gateway credentials only; provider credentials never enter Kora.
type Client struct {
	endpoint, key string
	http          *http.Client
}

// NewClient disables decisions when both settings are absent and refuses external origins.
func NewClient(baseURL, key string, transport *http.Client) (*Client, error) {
	if baseURL == "" && key == "" {
		return nil, nil
	}
	u, err := url.Parse(baseURL)
	if err != nil || u == nil || key == "" || strings.ContainsAny(key, "\r\n") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/v1" && u.Path != "/v1/") {
		return nil, ErrInvalid
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && host != "kora-ai.agentgateway-system.svc.cluster.local" && host != "kora-ai.agentgateway-system.svc" {
		return nil, ErrInvalid
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, ErrInvalid
	}
	var client http.Client
	if transport != nil {
		client = *transport
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	u.Path = "/v1/decisions"
	return &Client{endpoint: u.String(), key: key, http: &client}, nil
}

// Decide makes one attempt. Callers retain their deterministic path on any error.
func (c *Client) Decide(ctx context.Context, state json.RawMessage, questions map[string]Question) (result Result, err error) {
	if c == nil {
		return Result{}, ErrNotConfigured
	}
	token, ok := auth.VerifiedTokenFromContext(ctx)
	if !ok {
		return Result{}, ErrIdentity
	}
	ctx, cancel := context.WithTimeout(ctx, Deadline)
	defer cancel()
	ctx, span := otel.Tracer("github.com/tesserix/kora/api/internal/ai/decide").Start(ctx, "jev.decide")
	defer func() {
		if err != nil {
			span.SetStatus(codes.Error, "decision unavailable")
		} else {
			span.SetAttributes(attribute.String("gen_ai.response.model", result.Model), attribute.Int("gen_ai.usage.input_tokens", result.Usage.InputTokens), attribute.Int("gen_ai.usage.output_tokens", result.Usage.OutputTokens))
		}
		span.End()
	}()
	wire := make(map[string]questionWire, len(questions))
	if len(questions) < 1 || len(questions) > MaxQuestions || len(state) > MaxRequestBytes || !json.Valid(state) || bytes.Equal(bytes.TrimSpace(state), []byte("null")) {
		return Result{}, ErrInvalid
	}
	if first := bytes.TrimSpace(state)[0]; first != '{' && first != '[' && first != '"' {
		return Result{}, ErrInvalid
	}
	for name, q := range questions {
		if !identifier.MatchString(name) || q == nil {
			return Result{}, ErrInvalid
		}
		switch q.(type) {
		case Choice, Score, Noul:
		default:
			return Result{}, ErrInvalid
		}
		v, e := q.wire()
		if e != nil || strings.TrimSpace(v.Instructions) == "" || len(v.Instructions) > 4000 {
			return Result{}, ErrInvalid
		}
		wire[name] = v
	}
	body, e := json.Marshal(struct {
		Model     string                  `json:"model"`
		State     json.RawMessage         `json:"state"`
		Questions map[string]questionWire `json:"questions"`
	}{ModelAlias, state, wire})
	if e != nil || len(body) > MaxRequestBytes {
		return Result{}, ErrInvalid
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if e != nil {
		return Result{}, ErrInvalid
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("X-Kora-End-User-Token", "Bearer "+token)
	req.Header.Set("X-Kora-AI-Capability", "decide")
	req.Header.Set("X-Kora-AI-Context-Kind", "decision")
	req.Header.Set("X-Kora-RTK-Applied", "false")
	aitrace.Inject(ctx, req.Header)
	resp, e := c.http.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		if errors.Is(e, context.DeadlineExceeded) {
			return Result{}, context.DeadlineExceeded
		}
		return Result{}, ErrUnavailable
	}
	defer func() {
		// Response validation determines success; closing cannot change it.
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("%w (HTTP %d)", ErrUnavailable, resp.StatusCode)
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if e != nil || len(raw) > MaxResponseBytes {
		return Result{}, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || d.Decode(new(any)) != io.EOF || validate(result, wire) != nil {
		return Result{}, ErrInvalid
	}
	var presence struct {
		Answers map[string]struct {
			Probabilities map[string]*float64 `json:"probabilities"`
		} `json:"answers"`
		Usage *struct {
			InputTokens  *int `json:"input_tokens"`
			OutputTokens *int `json:"output_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &presence) != nil || presence.Usage == nil || presence.Usage.InputTokens == nil || presence.Usage.OutputTokens == nil {
		return Result{}, ErrInvalid
	}
	for _, answer := range presence.Answers {
		for _, p := range answer.Probabilities {
			if p == nil {
				return Result{}, ErrInvalid
			}
		}
	}
	return result, nil
}

func validate(result Result, questions map[string]questionWire) error {
	if !modelVersion.MatchString(result.Model) || len(result.Answers) != len(questions) || result.Usage.InputTokens < 0 || result.Usage.OutputTokens < 0 || result.Usage.InputTokens > 64000 || result.Usage.OutputTokens > 64000 {
		return ErrInvalid
	}
	for name, q := range questions {
		a, ok := result.Answers[name]
		if !ok || a.Type != q.Type {
			return ErrInvalid
		}
		if q.Type == "noul" {
			if a.Noul == nil || !probability(*a.Noul) || a.Confidence != nil || a.Score != nil || a.Choice != "" || len(a.Probabilities) != 0 || len(a.Legend) != 0 {
				return ErrInvalid
			}
			continue
		}
		if a.Confidence == nil || !probability(*a.Confidence) || a.Noul != nil {
			return ErrInvalid
		}
		options := map[string]bool{}
		if q.Type == "choice" {
			for id := range q.Criteria.(map[string]string) {
				options[id] = true
			}
			if !options[a.Choice] || a.Score != nil || len(a.Legend) != 0 {
				return ErrInvalid
			}
		} else {
			levels := q.Criteria.([]string)
			if a.Score == nil || math.IsNaN(*a.Score) || math.IsInf(*a.Score, 0) || *a.Score < 0 || *a.Score > float64(len(levels)-1) || a.Choice != "" {
				return ErrInvalid
			}
			for i, desc := range levels {
				id := strconv.Itoa(i)
				options[id] = true
				if a.Legend[id] != desc {
					return ErrInvalid
				}
			}
			if len(a.Legend) != len(levels) {
				return ErrInvalid
			}
		}
		if len(a.Probabilities) != len(options) {
			return ErrInvalid
		}
		sum := 0.0
		for id, p := range a.Probabilities {
			if !options[id] || !probability(p) {
				return ErrInvalid
			}
			sum += p
			if q.Type == "choice" && p > a.Probabilities[a.Choice]+1e-6 {
				return ErrInvalid
			}
		}
		if math.Abs(sum-1) > 0.001 {
			return ErrInvalid
		}
	}
	return nil
}

func probability(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}
