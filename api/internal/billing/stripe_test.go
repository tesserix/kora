package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	stripe "github.com/stripe/stripe-go/v82"
)

// stripeSignature builds the header Stripe sends: t=<unix>,v1=<hmac>. The MAC
// covers "<timestamp>.<payload>", which is what binds the timestamp into the
// signature and makes the freshness check meaningful rather than advisory.
func stripeSignature(t *testing.T, secret string, ts time.Time, payload []byte) string {
	t.Helper()
	signed := fmt.Sprintf("%d.%s", ts.Unix(), payload)
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(signed))
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(m.Sum(nil)))
}

// TestStripeLiveIsDerivedFromTheKeyNotAFlag pins the trap kora#478 names.
//
// `kora-api` runs ENV=production together with CASHFREE_SANDBOX=true on the
// live Deployment — two independent facts that silently contradict each other.
// Stripe must not be able to reproduce that, so test-versus-live comes from the
// credential itself and there is no flag that could disagree with it.
func TestStripeLiveIsDerivedFromTheKeyNotAFlag(t *testing.T) {
	require.False(t, StripeConfig{SecretKey: "sk_test_abc"}.Live(), "a test key must never transact live")
	require.True(t, StripeConfig{SecretKey: "sk_live_abc"}.Live())

	// Fail SAFE, not open: anything unrecognised is treated as live, because
	// mistaking a live key for a test one spends real money while the reverse
	// is merely noisy.
	require.True(t, StripeConfig{SecretKey: "rk_abc"}.Live(), "an unrecognised key must be assumed live")
	require.True(t, StripeConfig{SecretKey: ""}.Live())
}

// TestStripeConfiguredRequiresBothCredentials — a deployment that can take
// money but cannot verify the callback confirming it would strand every order
// in `created`, so the webhook secret gates mounting just as the API key does.
func TestStripeConfiguredRequiresBothCredentials(t *testing.T) {
	require.False(t, StripeConfig{}.Configured())
	require.False(t, StripeConfig{SecretKey: "sk_test_x"}.Configured(), "an API key alone must not mount payments")
	require.False(t, StripeConfig{WebhookSecret: "whsec_x"}.Configured())
	require.True(t, StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x"}.Configured())
}

// stripeTestClient points a real StripeClient at an httptest server.
func stripeTestClient(t *testing.T, cfg StripeConfig, h http.HandlerFunc) *StripeClient {
	t.Helper()
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	backend := stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		URL:           stripe.String(server.URL),
		LeveledLogger: stripe.DefaultLeveledLogger,
	})
	return NewStripeClientWithBackend(cfg, backend)
}

// TestStripeCreateOrderSendsTheExactTotalAndReturnsStripesURL
//
// Two properties at once: the amount transferred is the EXACT total in paise
// with no conversion, and the checkout URL returned is the one Stripe gave us
// rather than something reconstructed — the shape fix kora#478 made.
func TestStripeCreateOrderSendsTheExactTotalAndReturnsStripesURL(t *testing.T) {
	var gotPath, gotAmount, gotRef, gotCurrency string
	client := stripeTestClient(t,
		StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x", ReturnURL: "kora://billing/return"},
		func(w http.ResponseWriter, r *http.Request) {
			require.NoError(t, r.ParseForm())
			gotPath = r.URL.Path
			gotAmount = r.Form.Get("line_items[0][price_data][unit_amount]")
			gotCurrency = r.Form.Get("line_items[0][price_data][currency]")
			gotRef = r.Form.Get("client_reference_id")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"cs_test_1","url":"https://checkout.stripe.com/c/pay/cs_test_1","object":"checkout.session"}`))
		})

	pack, err := PackByCode("spark")
	require.NoError(t, err)
	breakdown := Price(pack)

	created, err := client.CreateOrder(
		context.Background(), "order-1", breakdown, "user-1", "9999999999", "a@b.dev", "Spark top-up")
	require.NoError(t, err)

	require.Equal(t, "/v1/checkout/sessions", gotPath)
	require.Equal(t, strconv.Itoa(breakdown.TotalPaise), gotAmount,
		"the exact total in paise must transfer with no currency conversion")
	require.Equal(t, "inr", gotCurrency)
	require.Equal(t, "order-1", gotRef,
		"Kora's own order id must ride on client_reference_id or the webhook cannot be reconciled")
	require.Equal(t, "https://checkout.stripe.com/c/pay/cs_test_1", created.CheckoutURL,
		"the URL must be Stripe's own, not reconstructed from the session id")
	require.Equal(t, "cs_test_1", created.CFOrderID)
}

// TestStripeCreateOrderFailsWhenThereIsNoCheckoutURL — a session with no URL
// cannot be paid, and handing the app an empty link would look like success.
func TestStripeCreateOrderFailsWhenThereIsNoCheckoutURL(t *testing.T) {
	client := stripeTestClient(t,
		StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x"},
		func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"cs_test_1","object":"checkout.session"}`))
		})

	pack, _ := PackByCode("spark")
	_, err := client.CreateOrder(context.Background(), "order-1", Price(pack), "u", "9", "a@b.dev", "note")
	require.Error(t, err)
}

// TestStripeFetchOrderMapsIntoKorasVocabulary
//
// The important case is `complete` + `unpaid`: a session reaches `complete`
// when the customer finishes the flow, which for asynchronous methods happens
// BEFORE the money settles. Reading that as PAID grants credit for a payment
// that can still fail.
func TestStripeFetchOrderMapsIntoKorasVocabulary(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
	}{
		{"paid", `{"id":"cs_1","object":"checkout.session","payment_status":"paid","status":"complete","amount_total":5900}`, GatewayPaid},
		{"expired", `{"id":"cs_1","object":"checkout.session","payment_status":"unpaid","status":"expired","amount_total":5900}`, GatewayExpired},
		{"complete but not yet paid", `{"id":"cs_1","object":"checkout.session","payment_status":"unpaid","status":"complete","amount_total":5900}`, ""},
		{"still open", `{"id":"cs_1","object":"checkout.session","payment_status":"unpaid","status":"open","amount_total":5900}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := stripeTestClient(t,
				StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x"},
				func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.body))
				})

			got, err := client.FetchOrder(context.Background(), "cs_1")
			require.NoError(t, err)
			require.Equal(t, tc.want, got.Status)
			require.Equal(t, 5900, got.AmountPaise)
		})
	}
}

// TestVerifyStripeWebhookAcceptsAFreshSignature
func TestVerifyStripeWebhookAcceptsAFreshSignature(t *testing.T) {
	const secret = "whsec_test"
	payload, err := json.Marshal(map[string]any{
		"id": "evt_1", "type": "checkout.session.completed", "data": map[string]any{"object": map[string]any{"id": "cs_1"}},
	})
	require.NoError(t, err)

	header := stripeSignature(t, secret, time.Now(), payload)
	event, err := VerifyStripeWebhook(secret, header, payload)
	require.NoError(t, err)
	require.Equal(t, "checkout.session.completed", string(event.Type))
}

// TestVerifyStripeWebhookRejectsAReplayOutsideTolerance is the security
// property that had to survive the port from Cashfree: the signature alone
// proves authorship, not freshness. Without the bound, a captured success
// callback could be replayed indefinitely to mint credit.
//
// The signature here is genuinely VALID — only the timestamp is old — so this
// fails for the right reason rather than because the MAC does not match.
func TestVerifyStripeWebhookRejectsAReplayOutsideTolerance(t *testing.T) {
	const secret = "whsec_test"
	payload := []byte(`{"id":"evt_1","type":"checkout.session.completed"}`)

	stale := time.Now().Add(-webhookTimestampTolerance - time.Minute)
	header := stripeSignature(t, secret, stale, payload)

	_, err := VerifyStripeWebhook(secret, header, payload)
	require.ErrorIs(t, err, ErrInvalidSignature)

	// And the same payload signed NOW is accepted, proving the rejection above
	// is about age rather than a malformed signature.
	fresh := stripeSignature(t, secret, time.Now(), payload)
	_, err = VerifyStripeWebhook(secret, fresh, payload)
	require.NoError(t, err)
}

// TestVerifyStripeWebhookRejectsAForgedSignature
func TestVerifyStripeWebhookRejectsAForgedSignature(t *testing.T) {
	payload := []byte(`{"id":"evt_1","type":"checkout.session.completed"}`)
	header := stripeSignature(t, "whsec_attacker", time.Now(), payload)

	_, err := VerifyStripeWebhook("whsec_real", header, payload)
	require.ErrorIs(t, err, ErrInvalidSignature)
}
