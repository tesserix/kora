package server

import (
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/billing"
)

// routeSet renders the mounted routes as "METHOD path" for exact assertions.
func routeSet(r *gin.Engine) map[string]bool {
	out := map[string]bool{}
	for _, ri := range r.Routes() {
		out[ri.Method+" "+ri.Path] = true
	}
	return out
}

func routerWith(cashfree billing.CashfreeConfig, stripe billing.StripeConfig) *gin.Engine {
	return NewRouter(Deps{
		DB:       &gorm.DB{},
		Verifier: stubVerifier{},
		Cashfree: cashfree,
		Stripe:   stripe,
	})
}

var (
	configuredCashfree = billing.CashfreeConfig{AppID: "app", SecretKey: "secret"}
	configuredStripe   = billing.StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x"}
)

// TestNoGatewayMountsNoCheckout — an environment with no gateway must advertise
// no checkout at all, rather than one that takes money and grants nothing.
func TestNoGatewayMountsNoCheckout(t *testing.T) {
	routes := routeSet(routerWith(billing.CashfreeConfig{}, billing.StripeConfig{}))

	require.False(t, routes["POST /v1/ai/orders"], "no gateway must mean no purchase surface")
	require.False(t, routes["POST /webhooks/cashfree"])
	require.False(t, routes["POST /webhooks/stripe"])
	// The metered read-only surface is NOT gated on a gateway: a user can see
	// what they have used without being able to buy more.
	require.True(t, routes["GET /v1/ai/usage"])
}

// TestCashfreeAloneMountsOnlyItsWebhook
func TestCashfreeAloneMountsOnlyItsWebhook(t *testing.T) {
	routes := routeSet(routerWith(configuredCashfree, billing.StripeConfig{}))

	require.True(t, routes["POST /v1/ai/orders"])
	require.True(t, routes["POST /webhooks/cashfree"])
	require.False(t, routes["POST /webhooks/stripe"], "an unconfigured Stripe must not expose a callback")
}

// TestStripeAloneMountsOnlyItsWebhook
func TestStripeAloneMountsOnlyItsWebhook(t *testing.T) {
	routes := routeSet(routerWith(billing.CashfreeConfig{}, configuredStripe))

	require.True(t, routes["POST /v1/ai/orders"])
	require.True(t, routes["POST /webhooks/stripe"])
	require.False(t, routes["POST /webhooks/cashfree"])
}

// TestStripeWinsWhenBothAreConfigured pins the migration's safety margin.
//
// During the cutover BOTH credentials exist at once — that overlap is the
// entire rollback plan for kora#479: if Stripe misbehaves under real traffic,
// clearing STRIPE_SECRET_KEY points config back at Cashfree rather than
// requiring a revert of merged code.
//
// Exactly ONE provider is mounted, never both. Two live checkout paths would
// mean two gateways able to settle the same order, and the webhook that lost
// the race would be reconciled against an order already paid.
func TestStripeWinsWhenBothAreConfigured(t *testing.T) {
	routes := routeSet(routerWith(configuredCashfree, configuredStripe))

	require.True(t, routes["POST /webhooks/stripe"], "Stripe is the gateway being cut over to")
	require.False(t, routes["POST /webhooks/cashfree"], "both gateways must never be mounted at once")
	require.True(t, routes["POST /v1/ai/orders"], "the buyer-facing surface is provider-independent")
}

// TestPurchaseRoutesAreIdenticalAcrossProviders — the routes a buyer uses must
// not differ by gateway, or the mobile app would have to know which one is
// configured. Only the webhook is provider-shaped.
func TestPurchaseRoutesAreIdenticalAcrossProviders(t *testing.T) {
	buyerSurface := []string{
		"GET /v1/ai/packs",
		"POST /v1/ai/orders",
		"GET /v1/ai/orders",
		"GET /v1/ai/orders/:id",
	}
	cashfree := routeSet(routerWith(configuredCashfree, billing.StripeConfig{}))
	stripe := routeSet(routerWith(billing.CashfreeConfig{}, configuredStripe))

	for _, route := range buyerSurface {
		require.True(t, cashfree[route], "cashfree is missing %s", route)
		require.True(t, stripe[route], "stripe is missing %s", route)
	}
}

// TestStripeNeedsBothCredentialsToMount — an API key without an endpoint
// signing secret could take money but never verify the callback confirming it,
// stranding every order in `created`.
func TestStripeNeedsBothCredentialsToMount(t *testing.T) {
	routes := routeSet(routerWith(billing.CashfreeConfig{}, billing.StripeConfig{SecretKey: "sk_test_x"}))

	require.False(t, routes["POST /webhooks/stripe"])
	require.False(t, routes["POST /v1/ai/orders"], "a half-configured Stripe must not sell anything")
}
