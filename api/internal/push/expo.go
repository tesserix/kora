package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"
const expoBatchSize = 100

// ExpoSender delivers pushes through the Expo Push API. It never panics;
// transport/decode errors are returned. An optional access token is sent as a
// Bearer credential when configured.
type ExpoSender struct {
	client *http.Client
	token  string
	url    string
}

func NewExpoSender(accessToken string) *ExpoSender {
	return &ExpoSender{
		client: &http.Client{Timeout: 10 * time.Second},
		token:  accessToken,
		url:    expoPushURL,
	}
}

type expoTicket struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

type expoResponse struct {
	Data []expoTicket `json:"data"`
}

func (s *ExpoSender) Send(ctx context.Context, messages []Message) ([]Receipt, error) {
	receipts := make([]Receipt, 0, len(messages))
	for start := 0; start < len(messages); start += expoBatchSize {
		end := start + expoBatchSize
		if end > len(messages) {
			end = len(messages)
		}
		batch := messages[start:end]
		batchReceipts, err := s.sendBatch(ctx, batch)
		if err != nil {
			// Preserve receipts already collected from earlier successful
			// batches instead of dropping them. The Dispatcher treats any Send
			// error as "do not mark → retry next tick"; a partial multi-batch
			// failure therefore re-sends the whole call next tick (an accepted
			// rare duplicate, consistent with the scheduler's best-effort
			// semantics). This path only triggers for >100 tokens in one Send.
			return receipts, err
		}
		receipts = append(receipts, batchReceipts...)
	}
	return receipts, nil
}

func (s *ExpoSender) sendBatch(ctx context.Context, batch []Message) ([]Receipt, error) {
	payload, err := json.Marshal(batch)
	if err != nil {
		return nil, fmt.Errorf("push: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("push: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("push: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("push: expo status %d", resp.StatusCode)
	}
	var body expoResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("push: decode: %w", err)
	}
	receipts := make([]Receipt, len(batch))
	for i, m := range batch {
		receipts[i] = Receipt{Token: m.To}
		if i < len(body.Data) {
			t := body.Data[i]
			receipts[i].DeviceNotRegistered = t.Status == "error" && t.Details.Error == "DeviceNotRegistered"
		}
	}
	return receipts, nil
}
