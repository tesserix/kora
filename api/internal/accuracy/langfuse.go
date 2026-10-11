package accuracy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sendTimeout   = 5 * time.Second
	maxInFlight   = 16
	scoresPath    = "/api/public/scores"
	scoreBodySize = 1 << 10
)

// Config points the client at Kora's Langfuse project. Missing keys disable scoring.
type Config struct {
	Host        string
	PublicKey   string
	SecretKey   string
	Environment string
}

// Client posts scores in the background; Langfuse being slow or down never fails a request.
type Client struct {
	cfg   Config
	http  *http.Client
	slots chan struct{}
	wg    sync.WaitGroup
}

// NewClient returns nil, a valid no-op client, when any setting is missing.
func NewClient(cfg Config) *Client {
	if cfg.Host == "" || cfg.PublicKey == "" || cfg.SecretKey == "" {
		return nil
	}
	cfg.Host = strings.TrimRight(cfg.Host, "/")
	return &Client{cfg: cfg, http: &http.Client{Timeout: sendTimeout}, slots: make(chan struct{}, maxInFlight)}
}

// Send queues scores for delivery and drops them when too many sends are already in flight.
func (c *Client) Send(ctx context.Context, scores []Score) {
	if c == nil || len(scores) == 0 {
		return
	}
	select {
	case c.slots <- struct{}{}:
	default:
		slog.WarnContext(ctx, "accuracy: scores dropped, Langfuse sends saturated", "count", len(scores))
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer func() { <-c.slots }()
		sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sendTimeout)
		defer cancel()
		for _, s := range scores {
			if err := c.post(sendCtx, s); err != nil {
				slog.WarnContext(sendCtx, "accuracy: score not sent", "score", s.Name, "err", err)
			}
		}
	}()
}

// Close waits for in-flight sends, bounded by ctx.
func (c *Client) Close(ctx context.Context) error {
	if c == nil {
		return nil
	}
	done := make(chan struct{})
	go func() { c.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type scoreBody struct {
	ID          string            `json:"id"`
	TraceID     string            `json:"traceId"`
	Name        string            `json:"name"`
	Value       float64           `json:"value"`
	DataType    string            `json:"dataType"`
	Comment     string            `json:"comment,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Environment string            `json:"environment,omitempty"`
}

func (c *Client) post(ctx context.Context, s Score) error {
	body, err := json.Marshal(scoreBody{
		ID: s.ID, TraceID: s.TraceID, Name: s.Name, Value: s.Value, DataType: s.DataType,
		Comment: s.Comment, Metadata: s.Metadata, Environment: c.cfg.Environment,
	})
	if err != nil {
		return fmt.Errorf("encode score: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Host+scoresPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(c.cfg.PublicKey, c.cfg.SecretKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("post score: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		var detail bytes.Buffer
		_, _ = detail.ReadFrom(io.LimitReader(resp.Body, scoreBodySize))
		return fmt.Errorf("langfuse returned %d: %s", resp.StatusCode, detail.String())
	}
	return nil
}
