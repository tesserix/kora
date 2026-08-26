package billing

import (
	"context"
	"errors"
	"fmt"
	"strings"

	stripe "github.com/stripe/stripe-go/v82"
	session "github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/webhook"
)

// StripeConfig is the merchant credential set for the Stripe gateway.
//
// There is deliberately NO sandbox flag. Stripe's test and live environments
// share one API host and are selected by the KEY itself (`sk_test_…` versus
// `sk_live_…`), so a separate switch could only ever disagree with the
// credential it accompanies.
//
// That is not hypothetical here: `kora-api` runs with `ENV=production` and
// `CASHFREE_SANDBOX=true` at the same time (verified on the live Deployment).
// With Cashfree those two facts are independent and nothing catches the
// contradiction. Deriving the environment from the key makes the same mistake
// unrepresentable (kora#478).
type StripeConfig struct {
	// SecretKey is the Stripe API key. Its prefix decides test versus live.
	SecretKey string
	// WebhookSecret is the endpoint's signing secret (`whsec_…`). It is a
	// DIFFERENT credential from SecretKey and is not derivable from it.
	WebhookSecret string
	// ReturnURL is the deep link Stripe sends the user back to. The payment
	// result is NOT trusted from it — only the webhook and an explicit status
	// fetch settle an order, exactly as with Cashfree.
	ReturnURL string
}

// Configured reports whether payments can run at all. An unconfigured Kora
// mounts no payment routes rather than failing requests at call time.
//
// WebhookSecret is required as well as SecretKey: a deployment that can take
// money but cannot verify the callback confirming it would strand every order
// in `created` until someone reconciled it by hand.
func (c StripeConfig) Configured() bool {
	return c.SecretKey != "" && c.WebhookSecret != ""
}

// Live reports whether this key transacts real money.
//
// Anything that is not explicitly a test key is treated as live. The asymmetry
// is deliberate: mistaking a live key for a test one spends real money, while
// mistaking a test key for a live one is merely noisy.
func (c StripeConfig) Live() bool {
	return !strings.HasPrefix(c.SecretKey, "sk_test_")
}

// StripeClient talks to Stripe Checkout. It satisfies `gateway`.
type StripeClient struct {
	cfg      StripeConfig
	sessions *session.Client
}

// NewStripeClient builds a client bound to cfg's key.
//
// The backend is Stripe's default, which already carries bounded timeouts and
// retries. Tests inject their own via NewStripeClientWithBackend rather than
// reaching the network.
func NewStripeClient(cfg StripeConfig) *StripeClient {
	return NewStripeClientWithBackend(cfg, stripe.GetBackend(stripe.APIBackend))
}

// NewStripeClientWithBackend is the seam tests use to point the client at an
// httptest server instead of api.stripe.com.
func NewStripeClientWithBackend(cfg StripeConfig, b stripe.Backend) *StripeClient {
	return &StripeClient{
		cfg:      cfg,
		sessions: &session.Client{B: b, Key: cfg.SecretKey},
	}
}

// CreateOrder opens a Stripe Checkout Session for one Kora order.
//
// `client_reference_id` carries Kora's own order id, which is what makes the
// webhook reconcilable: Stripe's session id is meaningless to Kora, and
// without this the callback could not be matched to a row.
//
// The amount is sent as the exact total in paise. Stripe's smallest-unit
// convention for INR is paise, so `breakdown.TotalPaise` transfers with no
// conversion — deliberately, since every currency conversion in a payment path
// is a rounding bug waiting to be found by a customer.
func (c *StripeClient) CreateOrder(
	ctx context.Context,
	orderID string,
	breakdown PriceBreakdown,
	customerID, phone, email, note string,
) (CreatedOrder, error) {
	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		ClientReferenceID: stripe.String(orderID),
		SuccessURL:        stripe.String(c.cfg.ReturnURL),
		CancelURL:         stripe.String(c.cfg.ReturnURL),
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			Quantity: stripe.Int64(1),
			PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{
				Currency:   stripe.String("inr"),
				UnitAmount: stripe.Int64(int64(breakdown.TotalPaise)),
				ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
					Name: stripe.String(note),
				},
			},
		}},
	}
	if email != "" {
		params.CustomerEmail = stripe.String(email)
	}
	params.Context = ctx

	s, err := c.sessions.New(params)
	if err != nil {
		return CreatedOrder{}, fmt.Errorf("billing: stripe create session: %w", err)
	}
	if s.URL == "" {
		// A session with no URL cannot be paid. Failing here keeps the order
		// in `failed` rather than handing the app a checkout link that is an
		// empty string.
		return CreatedOrder{}, fmt.Errorf("billing: stripe returned no checkout url for session %s", s.ID)
	}
	return CreatedOrder{
		CFOrderID:        s.ID,
		PaymentSessionID: s.ID,
		CheckoutURL:      s.URL,
	}, nil
}

// FetchOrder reads a session's authoritative state and maps it into Kora's
// gateway vocabulary (GatewayPaid / GatewayExpired).
//
// PaymentStatus is what decides PAID, not Status: a session reaches
// `complete` when the customer finishes the flow, which for asynchronous
// methods happens BEFORE the money settles. Reading `complete` as paid would
// grant credit for a payment that can still fail.
func (c *StripeClient) FetchOrder(ctx context.Context, orderID string) (OrderStatus, error) {
	params := &stripe.CheckoutSessionParams{}
	params.Context = ctx

	s, err := c.sessions.Get(orderID, params)
	if err != nil {
		return OrderStatus{}, fmt.Errorf("billing: stripe fetch session: %w", err)
	}

	out := OrderStatus{CFOrderID: s.ID, AmountPaise: int(s.AmountTotal)}
	switch {
	case s.PaymentStatus == stripe.CheckoutSessionPaymentStatusPaid:
		out.Status = GatewayPaid
	case s.Status == stripe.CheckoutSessionStatusExpired:
		out.Status = GatewayExpired
	}
	// Anything else is left empty on purpose: still in flight, and reconcile
	// leaves the order alone rather than guessing.
	return out, nil
}

// VerifyStripeWebhook authenticates a webhook delivery and returns the event.
//
// Tolerance is Kora's own `webhookTimestampTolerance`, passed explicitly rather
// than relying on webhook.DefaultTolerance. The two happen to be equal today
// (both five minutes); pinning it means the Cashfree and Stripe paths cannot
// drift apart because a dependency changed its default.
//
// The freshness bound is the point, not a detail: the signature alone proves
// authorship, not freshness, so without it a captured success callback could be
// replayed indefinitely. Stripe binds the timestamp into the signed payload,
// so this is enforced rather than advisory.
func VerifyStripeWebhook(webhookSecret string, signatureHeader string, rawBody []byte) (stripe.Event, error) {
	// IgnoreAPIVersionMismatch, deliberately, and this is the one judgement
	// call in this file worth arguing with.
	//
	// stripe-go otherwise rejects any event whose api_version differs from the
	// version the library pins (stripe.APIVersion, "2025-08-27.basil" at
	// v82.5.1). Refusing on that basis has two costs and no offsetting benefit
	// here:
	//
	//  1. It is INDISTINGUISHABLE from a bad signature. The package exports no
	//     sentinel for it, so a version mismatch would surface as "invalid
	//     signature" and send an operator hunting a key problem that does not
	//     exist — precisely the failure both bffauth and platformauth go out of
	//     their way to avoid.
	//  2. It fails CLOSED on settlement. A dashboard endpoint created against
	//     any other version would silently reject every delivery, leaving paid
	//     orders stuck in `created` with the user's money taken.
	//
	// It is safe to ignore because Kora reads only stable fields (id, type,
	// client_reference_id, payment_status, amount_total) and does not trust the
	// amount on its own: Settle compares it against the price frozen on the
	// order and returns ErrAmountMismatch, which is logged for a human rather
	// than granting credit. A wrong amount therefore fails loudly whatever
	// version produced it.
	//
	// The signature and the freshness bound are still enforced in full.
	event, err := webhook.ConstructEventWithOptions(rawBody, signatureHeader, webhookSecret,
		webhook.ConstructEventOptions{
			Tolerance:                webhookTimestampTolerance,
			IgnoreAPIVersionMismatch: true,
		})
	if err != nil {
		// Collapsed to one sentinel deliberately, matching the Cashfree path:
		// a caller learning WHICH half failed learns whether it holds a valid
		// key. ErrTooOld is checked explicitly so a replay is not reported as
		// a malformed signature in the server log.
		if errors.Is(err, webhook.ErrTooOld) {
			return stripe.Event{}, fmt.Errorf("%w: replayed outside tolerance", ErrInvalidSignature)
		}
		return stripe.Event{}, ErrInvalidSignature
	}
	return event, nil
}

// stripeEventIsTerminalSuccess reports whether an event says the money is in.
//
// `checkout.session.completed` alone is NOT enough: for asynchronous payment
// methods the session completes while the payment is still pending, so the
// payment status is checked as well. `async_payment_succeeded` is the event
// that later confirms those.
func stripeEventIsTerminalSuccess(e stripe.Event, s *stripe.CheckoutSession) bool {
	switch e.Type {
	case "checkout.session.async_payment_succeeded":
		return true
	case "checkout.session.completed":
		return s != nil && s.PaymentStatus == stripe.CheckoutSessionPaymentStatusPaid
	default:
		return false
	}
}
