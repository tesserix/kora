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

func routerWith(stripe billing.StripeConfig) *gin.Engine {
	return NewRouter(Deps{
		DB:       &gorm.DB{},
		Verifier: stubVerifier{},
		Stripe:   stripe,
	})
}

var configuredStripe = billing.StripeConfig{SecretKey: "sk_test_x", WebhookSecret: "whsec_x"}

// TestNoGatewayMountsNoCheckout — an environment with no gateway must advertise
// no checkout at all, rather than one that takes money and grants nothing.
//
// This is Kora's ACTUAL production state since kora#479 removed Cashfree, not
// a hypothetical: Stripe is merged but configured-off, and the iOS rail
// (StoreKit IAP, ADR 0004) is kora#487 and unbuilt. So this case is the one
// that describes today.
func TestNoGatewayMountsNoCheckout(t *testing.T) {
	routes := routeSet(routerWith(billing.StripeConfig{}))

	require.False(t, routes["POST /v1/ai/orders"], "no gateway must mean no purchase surface")
	require.False(t, routes["POST /webhooks/stripe"])
	// The metered read-only surface is NOT gated on a gateway: a user can see
	// what they have used without being able to buy more.
	require.True(t, routes["GET /v1/ai/usage"])
}

// TestStripeMountsItsOwnWebhookOnly — a configured gateway exposes its own
// callback and nothing else. No other provider's route may appear, because a
// second live checkout path would mean two gateways able to settle the same
// order.
func TestStripeMountsItsOwnWebhookOnly(t *testing.T) {
	routes := routeSet(routerWith(configuredStripe))

	require.True(t, routes["POST /v1/ai/orders"])
	require.True(t, routes["POST /webhooks/stripe"])
	require.False(t, routes["POST /webhooks/cashfree"],
		"Cashfree was removed in kora#479; its callback must never reappear")
}

// TestPurchaseRoutesAreProviderIndependent — the routes a buyer uses must not
// differ by gateway, or the mobile app would have to know which one is
// configured. Only the webhook is provider-shaped.
//
// Kept with one provider rather than deleted with Cashfree: this is the
// property a FUTURE rail has to satisfy, and it is the reason the buyer
// surface survived the removal unchanged.
func TestPurchaseRoutesAreProviderIndependent(t *testing.T) {
	buyerSurface := []string{
		"GET /v1/ai/packs",
		"POST /v1/ai/orders",
		"GET /v1/ai/orders",
		"GET /v1/ai/orders/:id",
	}
	routes := routeSet(routerWith(configuredStripe))

	for _, route := range buyerSurface {
		require.True(t, routes[route], "stripe is missing %s", route)
	}
}

// TestStripeNeedsBothCredentialsToMount — an API key without an endpoint
// signing secret could take money but never verify the callback confirming it,
// stranding every order in `created`.
func TestStripeNeedsBothCredentialsToMount(t *testing.T) {
	routes := routeSet(routerWith(billing.StripeConfig{SecretKey: "sk_test_x"}))

	require.False(t, routes["POST /webhooks/stripe"])
	require.False(t, routes["POST /v1/ai/orders"], "a half-configured Stripe must not sell anything")
}
