// Package mail sends Kora's own transactional email through Resend.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const resendURL = "https://api.resend.com/emails"

// Message is one email to one recipient. Text is always sent alongside HTML:
// clients that block HTML, and spam filters, both read it.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Resend delivers through Resend's HTTP API, the same provider Zitadel's own
// mail goes out through, under a key of Kora's own.
type Resend struct {
	client *http.Client
	key    string
	from   string
	url    string
}

// NewResend returns nil for an empty key, so callers can treat "no key" as
// "no mailer" with a single nil check.
func NewResend(apiKey, from string) *Resend {
	if apiKey == "" {
		return nil
	}
	return &Resend{
		client: &http.Client{Timeout: 10 * time.Second},
		key:    apiKey,
		from:   from,
		url:    resendURL,
	}
}

func (r *Resend) Send(ctx context.Context, m Message) error {
	payload, err := json.Marshal(map[string]any{
		"from":    r.from,
		"to":      []string{m.To},
		"subject": m.Subject,
		"text":    m.Text,
		"html":    m.HTML,
	})
	if err != nil {
		return fmt.Errorf("mail: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("mail: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.key)
	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("mail: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		// Resend's error body names the problem (unverified domain, bad key)
		// and never echoes the message, so it is safe to log.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("mail: resend status %d: %s", resp.StatusCode, bytes.TrimSpace(detail))
	}
	return nil
}
