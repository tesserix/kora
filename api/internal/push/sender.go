// Package push turns notification rows into OS pushes via a dispatcher ticker.
package push

import "context"

// Message is a single push to one device token.
type Message struct {
	To    string         `json:"to"`
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Data  map[string]any `json:"data,omitempty"`
}

// Receipt is the per-message delivery result. DeviceNotRegistered signals the
// token is dead and should be pruned.
type Receipt struct {
	Token               string
	DeviceNotRegistered bool
}

// Sender delivers a batch of push messages.
type Sender interface {
	Send(ctx context.Context, messages []Message) ([]Receipt, error)
}

// NoopSender accepts every message and reports success (no pruning). Used in
// tests and as a safe default.
type NoopSender struct{}

func (NoopSender) Send(_ context.Context, messages []Message) ([]Receipt, error) {
	receipts := make([]Receipt, len(messages))
	for i, m := range messages {
		receipts[i] = Receipt{Token: m.To}
	}
	return receipts, nil
}
