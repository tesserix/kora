package billing

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// cashfreeAPIVersion pins the Orders API contract. Cashfree versions by date
// header, and an unpinned client silently follows their latest release — which
// is how a payment integration breaks without a deploy.
const cashfreeAPIVersion = "2023-08-01"

// webhookTimestampTolerance bounds how old a signed webhook may be. The
// signature alone proves authorship, not freshness: without this, a captured
// success callback could be replayed indefinitely.
const webhookTimestampTolerance = 5 * time.Minute

// ErrInvalidSignature means a webhook did not come from Cashfree, or was
// replayed outside the tolerance window. It is never surfaced to the caller in
// detail — the endpoint answers 401 and says nothing more.
var ErrInvalidSignature = errors.New("billing: invalid webhook signature")

// CashfreeConfig is the merchant credential set plus the environment it
// belongs to. Sandbox and production keys are NOT interchangeable, and using
// one against the other's base URL fails in ways that look like bad
// credentials, so the base URL is derived from the same value.
type CashfreeConfig struct {
	AppID     string
	SecretKey string
	// Sandbox selects Cashfree's test environment.
	Sandbox bool
	// ReturnURL is where the hosted checkout sends the user back. It is a deep
	// link into the app; the payment result is NOT trusted from it — only the
	// webhook and an explicit status fetch settle an order.
	ReturnURL string
}

func (c CashfreeConfig) baseURL() string {
	if c.Sandbox {
		return "https://sandbox.cashfree.com/pg"
	}
	return "https://api.cashfree.com/pg"
}

// checkoutHost is where the user is sent to actually pay.
func (c CashfreeConfig) checkoutHost() string {
	if c.Sandbox {
		return "https://payments-test.cashfree.com"
	}
	return "https://payments.cashfree.com"
}

// CheckoutURL builds the hosted checkout link for a payment session.
//
// The SERVER builds it, not the app: the environment (sandbox or production)
// is a server-side fact, and an app that assembled gateway URLs itself would
// need to know which one it was talking to — a mismatch there sends real
// customers to the test gateway.
func (c *CashfreeClient) CheckoutURL(paymentSessionID string) string {
	if paymentSessionID == "" {
		return ""
	}
	return c.cfg.checkoutHost() + "/order/#" + paymentSessionID
}

// Configured reports whether payments can run at all. An unconfigured Kora
// mounts no payment routes rather than failing requests at call time.
func (c CashfreeConfig) Configured() bool {
	return c.AppID != "" && c.SecretKey != ""
}

// CashfreeClient talks to the Cashfree Payment Gateway.
type CashfreeClient struct {
	cfg  CashfreeConfig
	http *http.Client
	// base is overridable so tests can point at an httptest server without
	// reaching the real gateway.
	base string
}

// NewCashfreeClient builds a client with a bounded HTTP timeout. A payment
// call that hangs would hold a request goroutine and, worse, leave the user
// staring at a spinner with an order in an unknown state.
func NewCashfreeClient(cfg CashfreeConfig) *CashfreeClient {
	return &CashfreeClient{
		cfg:  cfg,
		http: &http.Client{Timeout: 20 * time.Second},
		base: cfg.baseURL(),
	}
}

// CreatedOrder is what the gateway hands back for a new order: the session the
// mobile SDK or hosted checkout needs, and the gateway's own order id.
type CreatedOrder struct {
	CFOrderID        string
	PaymentSessionID string
}

type cashfreeCustomer struct {
	CustomerID    string `json:"customer_id"`
	CustomerEmail string `json:"customer_email,omitempty"`
	CustomerPhone string `json:"customer_phone"`
}

type cashfreeOrderMeta struct {
	ReturnURL string `json:"return_url,omitempty"`
}

type cashfreeOrderRequest struct {
	OrderID       string            `json:"order_id"`
	OrderAmount   string            `json:"order_amount"`
	OrderCurrency string            `json:"order_currency"`
	OrderNote     string            `json:"order_note,omitempty"`
	Customer      cashfreeCustomer  `json:"customer_details"`
	OrderMeta     cashfreeOrderMeta `json:"order_meta"`
}

type cashfreeOrderResponse struct {
	CFOrderID        string `json:"cf_order_id"`
	PaymentSessionID string `json:"payment_session_id"`
	OrderStatus      string `json:"order_status"`
	Message          string `json:"message"`
	Code             string `json:"code"`
}

// CreateOrder registers an order with the gateway for the exact total in
// breakdown.
//
// orderID is Kora's own id, sent as the gateway's order_id, which makes the
// two systems reconcilable in one direction without a lookup table and makes
// a duplicate submission a gateway-side conflict rather than a second charge.
//
// The amount is rendered from integer paise at the last possible moment.
// Cashfree wants rupees as a decimal string; formatting from paise means the
// string can never disagree with what was stored.
func (c *CashfreeClient) CreateOrder(
	ctx context.Context,
	orderID string,
	breakdown PriceBreakdown,
	customerID, phone, email, note string,
) (CreatedOrder, error) {
	body := cashfreeOrderRequest{
		OrderID:       orderID,
		OrderAmount:   Rupees(breakdown.TotalPaise),
		OrderCurrency: "INR",
		OrderNote:     note,
		Customer: cashfreeCustomer{
			CustomerID:    customerID,
			CustomerEmail: email,
			CustomerPhone: phone,
		},
		OrderMeta: cashfreeOrderMeta{ReturnURL: c.cfg.ReturnURL},
	}
	var out cashfreeOrderResponse
	if err := c.do(ctx, http.MethodPost, "/orders", body, &out); err != nil {
		return CreatedOrder{}, err
	}
	if out.PaymentSessionID == "" {
		return CreatedOrder{}, fmt.Errorf("billing: cashfree returned no payment session (%s %s)", out.Code, out.Message)
	}
	return CreatedOrder{CFOrderID: out.CFOrderID, PaymentSessionID: out.PaymentSessionID}, nil
}

// OrderStatus is the gateway's view of an order. Kora asks for this rather
// than trusting the client's return-URL landing, which a user can forge simply
// by opening the deep link.
type OrderStatus struct {
	Status      string
	CFOrderID   string
	AmountPaise int
}

type cashfreeOrderStatusResponse struct {
	CFOrderID   string  `json:"cf_order_id"`
	OrderStatus string  `json:"order_status"`
	OrderAmount float64 `json:"order_amount"`
}

// FetchOrder reads an order's authoritative state from the gateway.
func (c *CashfreeClient) FetchOrder(ctx context.Context, orderID string) (OrderStatus, error) {
	var out cashfreeOrderStatusResponse
	if err := c.do(ctx, http.MethodGet, "/orders/"+orderID, nil, &out); err != nil {
		return OrderStatus{}, err
	}
	return OrderStatus{
		Status:    out.OrderStatus,
		CFOrderID: out.CFOrderID,
		// Rounded, not truncated: 60.18 arrives as 60.17999999999999 often
		// enough that truncation would report a paisa short and fail the
		// amount check on a perfectly good payment.
		AmountPaise: int(out.OrderAmount*100 + 0.5),
	}, nil
}

func (c *CashfreeClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("billing: encode cashfree request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return fmt.Errorf("billing: build cashfree request: %w", err)
	}
	req.Header.Set("x-api-version", cashfreeAPIVersion)
	req.Header.Set("x-client-id", c.cfg.AppID)
	req.Header.Set("x-client-secret", c.cfg.SecretKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("billing: call cashfree: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("billing: read cashfree response: %w", err)
	}
	if resp.StatusCode >= 300 {
		// The response body is NOT included: it echoes request fields, and
		// this error is logged. Status and path are enough to diagnose.
		return fmt.Errorf("billing: cashfree %s %s returned %d", method, path, resp.StatusCode)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("billing: decode cashfree response: %w", err)
	}
	return nil
}

// VerifyWebhook authenticates a webhook delivery.
//
// Cashfree signs base64(HMAC-SHA256(timestamp + rawBody, secretKey)). The
// signature MUST be computed over the raw bytes as received: re-encoding the
// parsed JSON changes key order and whitespace, and the resulting MAC never
// matches — the single most common way this integration is got wrong.
func VerifyWebhook(secretKey, timestamp, signature string, rawBody []byte, now time.Time) error {
	if secretKey == "" || signature == "" || timestamp == "" {
		return ErrInvalidSignature
	}
	sent, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		// Cashfree also sends epoch seconds on some webhook versions.
		epoch, epochErr := parseEpochSeconds(timestamp)
		if epochErr != nil {
			return ErrInvalidSignature
		}
		sent = epoch
	}
	if diff := now.Sub(sent); diff > webhookTimestampTolerance || diff < -webhookTimestampTolerance {
		return ErrInvalidSignature
	}

	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(timestamp))
	mac.Write(rawBody)
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	// Constant time: a byte-by-byte comparison leaks how much of a forged
	// signature was right, which is enough to recover one.
	if !hmac.Equal([]byte(want), []byte(strings.TrimSpace(signature))) {
		return ErrInvalidSignature
	}
	return nil
}

func parseEpochSeconds(value string) (time.Time, error) {
	var seconds int64
	if _, err := fmt.Sscanf(strings.TrimSpace(value), "%d", &seconds); err != nil {
		return time.Time{}, err
	}
	if seconds <= 0 {
		return time.Time{}, errors.New("billing: non-positive epoch")
	}
	return time.Unix(seconds, 0).UTC(), nil
}

// WebhookEvent is the part of a Cashfree payment webhook Kora acts on.
type WebhookEvent struct {
	Type string `json:"type"`
	Data struct {
		Order struct {
			OrderID     string  `json:"order_id"`
			OrderAmount float64 `json:"order_amount"`
		} `json:"order"`
		Payment struct {
			CFPaymentID   any     `json:"cf_payment_id"`
			PaymentStatus string  `json:"payment_status"`
			PaymentAmount float64 `json:"payment_amount"`
		} `json:"payment"`
	} `json:"data"`
}

// PaymentID renders cf_payment_id, which Cashfree sends as a number in some
// versions and a string in others. Decoding it as either concrete type drops
// the id for half of them.
func (e WebhookEvent) PaymentID() string {
	switch v := e.Data.Payment.CFPaymentID.(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%.0f", v)
	default:
		return ""
	}
}

// AmountPaise is the amount actually paid, in paise.
func (e WebhookEvent) AmountPaise() int {
	return int(e.Data.Payment.PaymentAmount*100 + 0.5)
}

// Succeeded reports whether this delivery says the payment went through.
func (e WebhookEvent) Succeeded() bool {
	return e.Data.Payment.PaymentStatus == "SUCCESS"
}
