package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func sign(t *testing.T, secret, timestamp string, body []byte) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyWebhookAcceptsAGenuineDelivery(t *testing.T) {
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK"}`)
	ts := now.Format(time.RFC3339)
	require.NoError(t, VerifyWebhook("secret", ts, sign(t, "secret", ts, body), body, now))
}

func TestVerifyWebhookAcceptsAnEpochTimestamp(t *testing.T) {
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK"}`)
	ts := "1787734800"
	sent, err := parseEpochSeconds(ts)
	require.NoError(t, err)
	require.NoError(t, VerifyWebhook("secret", ts, sign(t, "secret", ts, body), body, sent.Add(time.Minute)))
}

// The signature covers the RAW bytes. Re-encoding the parsed JSON changes key
// order and whitespace, so a MAC over re-encoded input must not verify.
func TestVerifyWebhookRejectsReEncodedBody(t *testing.T) {
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	raw := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"o1"}}}`)
	ts := now.Format(time.RFC3339)
	signature := sign(t, "secret", ts, raw)

	var parsed map[string]any
	require.NoError(t, json.Unmarshal(raw, &parsed))
	reEncoded, err := json.Marshal(parsed)
	require.NoError(t, err)

	require.ErrorIs(t, VerifyWebhook("secret", ts, signature, reEncoded, now), ErrInvalidSignature)
}

func TestVerifyWebhookRejectsAForgedOrStaleDelivery(t *testing.T) {
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK"}`)
	ts := now.Format(time.RFC3339)
	good := sign(t, "secret", ts, body)

	require.ErrorIs(t, VerifyWebhook("secret", ts, sign(t, "wrong-secret", ts, body), body, now), ErrInvalidSignature)
	require.ErrorIs(t, VerifyWebhook("secret", ts, "", body, now), ErrInvalidSignature)
	require.ErrorIs(t, VerifyWebhook("", ts, good, body, now), ErrInvalidSignature)
	require.ErrorIs(t, VerifyWebhook("secret", "not-a-time", good, body, now), ErrInvalidSignature)

	// A captured delivery replayed an hour later is refused even though its
	// signature is perfectly valid.
	replayed := now.Add(time.Hour)
	require.ErrorIs(t, VerifyWebhook("secret", ts, good, body, replayed), ErrInvalidSignature)
}

func TestCreateOrderSendsTheExactTotalAndPinnedAPIVersion(t *testing.T) {
	var gotPath, gotVersion, gotClientID, gotSecret string
	var gotBody cashfreeOrderRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotVersion = r.URL.Path, r.Header.Get("x-api-version")
		gotClientID, gotSecret = r.Header.Get("x-client-id"), r.Header.Get("x-client-secret")
		payload, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(payload, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"cf_order_id":"cf-1","payment_session_id":"session-1","order_status":"ACTIVE"}`))
	}))
	defer server.Close()

	client := NewCashfreeClient(CashfreeConfig{AppID: "app", SecretKey: "secret", ReturnURL: "kora://billing"})
	client.base = server.URL

	pack, err := PackByCode("spark")
	require.NoError(t, err)
	created, err := client.CreateOrder(
		context.Background(), "order-1", Price(pack), "user-1", "9999999999", "a@b.dev", "Spark top-up")
	require.NoError(t, err)

	// CheckoutURL is now returned BY the provider rather than derived by the
	// caller (kora#478), so it is part of what CreateOrder must produce. The
	// host is the production one because this config leaves Sandbox false —
	// which is the property that must never be assembled app-side.
	require.Equal(t, CreatedOrder{
		CFOrderID:        "cf-1",
		PaymentSessionID: "session-1",
		CheckoutURL:      "https://payments.cashfree.com/order/#session-1",
	}, created)
	require.Equal(t, "/orders", gotPath)
	require.Equal(t, cashfreeAPIVersion, gotVersion)
	require.Equal(t, "app", gotClientID)
	require.Equal(t, "secret", gotSecret)
	require.Equal(t, "60.18", gotBody.OrderAmount, "the gateway collects the itemised total, not the base price")
	require.Equal(t, "INR", gotBody.OrderCurrency)
	require.Equal(t, "order-1", gotBody.OrderID, "Kora's own id is the gateway's order id")
	require.Equal(t, "kora://billing", gotBody.OrderMeta.ReturnURL)
}

func TestCreateOrderFailsWhenTheGatewayReturnsNoSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"order_amount_invalid","message":"nope"}`))
	}))
	defer server.Close()

	client := NewCashfreeClient(CashfreeConfig{AppID: "app", SecretKey: "secret"})
	client.base = server.URL

	pack, _ := PackByCode("spark")
	_, err := client.CreateOrder(context.Background(), "order-1", Price(pack), "user-1", "9999999999", "", "")
	require.Error(t, err)
}

func TestCreateOrderFailsOnAGatewayError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"bad"}`))
	}))
	defer server.Close()

	client := NewCashfreeClient(CashfreeConfig{AppID: "app", SecretKey: "secret"})
	client.base = server.URL

	pack, _ := PackByCode("spark")
	_, err := client.CreateOrder(context.Background(), "order-1", Price(pack), "user-1", "9999999999", "", "")
	require.Error(t, err)
}

// Float amounts from the gateway arrive as 60.17999…; truncating would report
// a paisa short and reject a good payment.
func TestFetchOrderRoundsTheAmountRatherThanTruncating(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"cf_order_id":"cf-1","order_status":"PAID","order_amount":60.18}`))
	}))
	defer server.Close()

	client := NewCashfreeClient(CashfreeConfig{AppID: "app", SecretKey: "secret"})
	client.base = server.URL

	status, err := client.FetchOrder(context.Background(), "order-1")
	require.NoError(t, err)
	require.Equal(t, OrderStatus{Status: "PAID", CFOrderID: "cf-1", AmountPaise: 6_018}, status)
}

func TestWebhookEventReadsEitherPaymentIDShape(t *testing.T) {
	var numeric WebhookEvent
	require.NoError(t, json.Unmarshal(
		[]byte(`{"data":{"payment":{"cf_payment_id":1234567,"payment_status":"SUCCESS","payment_amount":60.18}}}`),
		&numeric))
	require.Equal(t, "1234567", numeric.PaymentID())
	require.Equal(t, 6_018, numeric.AmountPaise())
	require.True(t, numeric.Succeeded())

	var stringy WebhookEvent
	require.NoError(t, json.Unmarshal(
		[]byte(`{"data":{"payment":{"cf_payment_id":"1234567","payment_status":"FAILED"}}}`),
		&stringy))
	require.Equal(t, "1234567", stringy.PaymentID())
	require.False(t, stringy.Succeeded())
}

func TestCashfreeConfigSelectsEnvironmentAndReportsReadiness(t *testing.T) {
	require.False(t, CashfreeConfig{}.Configured())
	require.False(t, CashfreeConfig{AppID: "app"}.Configured())
	require.True(t, CashfreeConfig{AppID: "app", SecretKey: "secret"}.Configured())

	require.Equal(t, "https://api.cashfree.com/pg", CashfreeConfig{}.baseURL())
	require.Equal(t, "https://sandbox.cashfree.com/pg", CashfreeConfig{Sandbox: true}.baseURL())
}
