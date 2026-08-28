package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/resolve"
)

// This file guards a STRUCTURAL property, not a curated list of endpoints:
// every route mounted under /v1 must sit behind auth.Middleware(deps.Verifier)
// unless it is named in v1AuthAllowlist with a reason. Without this, a route
// added outside the `v1 := r.Group("/v1", auth.Middleware(...))` block — by a
// bad merge, or by someone reaching for r.GET instead of v1.GET — would serve
// unauthenticated traffic with nothing in the suite going red (kora#371).
//
// TestAnonymousRequestsCannotReachAnyPublicAICapability (router_test.go) is a
// DIFFERENT, narrower guarantee: it curates a hand-picked list of public-AI
// endpoints. It is intentionally left alone — diluting it with unrelated
// routes (like /v1/health/sync, kora#30) would blur what it means. This test
// instead DISCOVERS routes from the live router via engine.Routes(), so a
// route neither test's author remembered to add still gets checked.
//
// # Coverage boundary
//
// This test only sees routes that the router IT BUILDS actually mounts.
// router.go gates several groups of /v1 routes behind Deps fields being
// non-nil/non-empty (DB, Verifier, AppleExchanger, Resolver, Agents, Stripe,
// BFFHMACKey, PlatformAdminSecret) — see the `if deps.X != nil` / `switch`
// blocks in NewRouter. TestEveryV1RouteRequiresAuthUnlessAllowlisted below
// deliberately supplies ALL of these (including a real, unreachable
// agents.Coordinator and a stub AppleExchanger — both cheap to construct
// with no network I/O, since construction alone is enough to register their
// routes) so that every conditionally-mounted /v1 route is discovered, not
// just the ones that happen to be wired in a minimal test Deps. If a future
// route is added inside a NEW conditional block gated on a Deps field this
// test does not set, it would silently escape this test the same way #371's
// route escaped the curated list — so any new gating field added to Deps
// must be wired here too, not just left to default to its zero value.
//
// v1AuthAllowlist is the load-bearing part. Every route under /v1 that is NOT
// behind auth.Middleware must be listed here, each with a comment stating
// exactly why it is exempt. Adding a route outside the authenticated group
// must be a decision someone writes down, not an omission this test lets
// slide. Allowlisting a route does NOT mean "skip it": the test below still
// sends an unauthenticated request to every allowlisted route and requires
// it to come back refused (some 4xx), just under a different scheme that
// this test does not pin exactly — see the allowlisted sub-test's comment.
var v1AuthAllowlist = map[string]string{
	// /v1/admin/* (tesserix-home admin portal). Mounted on its OWN group in
	// router.go (`r.Group("/v1/admin", bffauth.Middleware(...))`), separate
	// from the Firebase-authed `v1` group: the caller is a platform admin
	// signing an HMAC request, never a Firebase end user. Expected scheme:
	// bffauth. An unauthenticated request here is still refused —
	// bffauth.Middleware answers 401 "invalid or missing signature" — just
	// not with auth.Middleware's "invalid or missing token" body this test
	// checks for on every non-allowlisted route.
	"GET /v1/admin/foods":          "bffauth: admin portal route, not Firebase auth",
	"GET /v1/admin/foods/:id":      "bffauth: admin portal route, not Firebase auth",
	"GET /v1/admin/events":         "bffauth: admin portal route, not Firebase auth",
	"POST /v1/admin/foods":         "bffauth: admin portal route, not Firebase auth",
	"PATCH /v1/admin/foods/:id":    "bffauth: admin portal route, not Firebase auth",
	"DELETE /v1/admin/foods/:id":   "bffauth: admin portal route, not Firebase auth",
	"GET /v1/admin/feedback":       "bffauth: admin portal route, not Firebase auth",
	"PATCH /v1/admin/feedback/:id": "bffauth: admin portal route, not Firebase auth",
	"GET /v1/admin/users":          "bffauth: admin portal route, not Firebase auth",
	"GET /v1/admin/users/:id":      "bffauth: admin portal route, not Firebase auth",
	"DELETE /v1/admin/users/:id":   "bffauth: admin portal route, not Firebase auth",

	// /v1/admin/* (platform console). A SECOND group on the same prefix
	// (platformadmin.Register), behind platformauth instead of bffauth — see
	// that package's doc for why the portal and the console cannot share one
	// scheme. Expected scheme: platformauth. An unsigned caller is still
	// refused (401 "unauthenticated"), again just not with auth.Middleware's
	// body.
	"GET /v1/admin/audit-logs":                   "platformauth: platform console route, not Firebase auth",
	"GET /v1/admin/inbox":                        "platformauth: platform console route, not Firebase auth",
	"GET /v1/admin/entities/:type":               "platformauth: platform console route, not Firebase auth",
	"GET /v1/admin/health":                       "platformauth: platform console route, not Firebase auth",
	"GET /v1/admin/kpis":                         "platformauth: platform console route, not Firebase auth",
	"GET /v1/admin/ai-metrics":                   "platformauth: platform console route, not Firebase auth",
	"POST /v1/admin/inbox/:id/actions/:actionId": "platformauth: platform console route, not Firebase auth",
}

// concretePath turns a gin route TEMPLATE ("/v1/logs/:id", "/v1/admin/entities/:type")
// into a real URL gin's router will match ("/v1/logs/dummy-id",
// "/v1/admin/entities/dummy-type") by substituting a plausible literal for
// every ":param" and "*param" segment.
//
// This exists so a 404 from an unmatched path parameter can never be
// mistaken for the 401 this test is actually looking for — sending the
// literal template string ("/v1/logs/:id") would hit NoRoute, not the
// route's own middleware chain, and the test would pass for the wrong
// reason.
func concretePath(pattern string) string {
	segments := strings.Split(pattern, "/")
	for i, seg := range segments {
		switch {
		case strings.HasPrefix(seg, ":"):
			segments[i] = "dummy-" + seg[1:]
		case strings.HasPrefix(seg, "*"):
			segments[i] = "dummy-" + seg[1:]
		}
	}
	return strings.Join(segments, "/")
}

// stubAppleExchanger is never invoked — its only job is to be non-nil so
// router.go mounts POST /v1/me/apple-authorization for discovery below.
type stubAppleExchanger struct{}

func (stubAppleExchanger) ExchangeAuthorizationCode(context.Context, string) (string, error) {
	return "", nil
}

// testCoordinator builds a real, but never-called, agents.Coordinator so
// router.go mounts the /v1/agents routes for discovery below. NewRegistry
// and NewGateway do no network I/O at construction — they only validate that
// BaseURL/APIKey are non-empty and build a struct — so a bogus, unreachable
// URL is safe here: nothing in this test ever calls Run or Resolve.
func testCoordinator() *agents.Coordinator {
	registry := agents.NewRegistry(agents.RegistryOptions{
		BaseURL: "https://agents.invalid",
		APIKey:  "test-key",
	})
	gateway := agents.NewGateway("https://agents.invalid", "test-key", nil)
	return agents.NewCoordinator(registry, gateway, nil)
}

// TestEveryV1RouteRequiresAuthUnlessAllowlisted is the route-wide assertion
// kora#371 asks for. It discovers every /v1 route the router actually
// registers (rather than a hand-maintained list, which is exactly what let
// the gap in #371 go unnoticed) and, for each one, either:
//
//   - confirms an unauthenticated request gets auth.Middleware's specific
//     401 refusal, or
//   - requires the route to be named in v1AuthAllowlist with a reason, AND
//     still confirms an unauthenticated request is refused with SOME 4xx
//     (see the allowlisted sub-test below) — allowlisting exempts a route
//     from the exact Firebase-auth body, never from being checked at all.
//
// A route registered by `r.GET(...)` instead of `v1.GET(...)` would be
// discovered here, would not produce the 401 body, and is not (and must
// never quietly become) in the allowlist — so it fails the test. That is
// the regression this exists to catch; see the RED/GREEN proof in the PR
// description for kora#371.
func TestEveryV1RouteRequiresAuthUnlessAllowlisted(t *testing.T) {
	h := resolve.NewHandler(nil, nil) // never invoked — routes only need to exist
	r := NewRouter(Deps{
		DB:       &gorm.DB{},
		Verifier: stubVerifier{},
		Resolver: &h,
		Provider: stubProvider{},
		// Mounts the bffauth admin group so its routes are discovered and
		// must be explicitly allowlisted, rather than simply absent from
		// this run and untested by accident.
		BFFHMACKey: []byte(adminTestKey),
		// Mounts the platformauth console group for the same reason.
		PlatformAdminSecret: platformTestSecret,
		// Mounts the purchase routes (GET/POST /v1/ai/...) so they are
		// checked too — they live inside the `v1` group like everything
		// else, and Configured() only needs non-empty strings to build.
		Stripe: billing.StripeConfig{
			SecretKey:     "sk_test_dummy",
			WebhookSecret: "whsec_dummy",
		},
		// Mounts POST /v1/me/apple-authorization — see the coverage-boundary
		// comment above v1AuthAllowlist.
		AppleExchanger: stubAppleExchanger{},
		// Mounts /v1/agents* — same reasoning.
		Agents: testCoordinator(),
	})

	routes := r.Routes()
	checked, allowlisted := 0, 0
	for _, route := range routes {
		if !strings.HasPrefix(route.Path, "/v1") {
			continue
		}
		key := route.Method + " " + route.Path

		if reason, ok := v1AuthAllowlist[key]; ok {
			allowlisted++
			t.Run(key+"/allowlisted", func(t *testing.T) {
				if reason == "" {
					t.Fatalf("%s is allowlisted with no reason — every exemption must say why", key)
				}

				target := concretePath(route.Path)
				req := httptest.NewRequest(route.Method, target, nil)
				w := httptest.NewRecorder()
				r.ServeHTTP(w, req)

				if w.Code == http.StatusNotFound {
					t.Fatalf("unauthenticated request to %s %s got 404 (path substitution %q did not match the route) — cannot conclude anything",
						route.Method, route.Path, target)
				}

				// Deliberately weaker than the non-allowlisted assertion
				// below: this only proves SOME auth scheme still refuses an
				// unauthenticated caller, not which one or what shape. The
				// precise refusal bodies for bffauth and platformauth are
				// already pinned by their own suites (bffauth_test.go,
				// platform_admin_routes_test.go's
				// TestContractRoutesRejectAnUnsignedCaller) — duplicating
				// those exact bodies here would just be a second place to
				// update when either middleware's wording changes.
				if w.Code < 400 || w.Code >= 500 {
					t.Fatalf("%s %s is allowlisted as %q but an unauthenticated request got %d — an allowlisted route must still refuse, just under a different scheme",
						route.Method, route.Path, reason, w.Code)
				}
			})
			continue
		}

		checked++
		t.Run(key, func(t *testing.T) {
			target := concretePath(route.Path)
			req := httptest.NewRequest(route.Method, target, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			// A 404 here means concretePath's substitution didn't match this
			// route after all — that would silently pass the test for the
			// wrong reason, so fail loudly instead of asserting past it.
			if w.Code == http.StatusNotFound {
				t.Fatalf("unauthenticated request to %s %s got 404 (path substitution %q did not match the route) — cannot conclude anything about auth",
					route.Method, route.Path, target)
			}

			assert.Equal(t, http.StatusUnauthorized, w.Code,
				"%s %s must require Firebase auth (or be added to v1AuthAllowlist with a reason)", route.Method, route.Path)
			assert.JSONEq(t, `{"error":"unauthorized","message":"invalid or missing token"}`, w.Body.String(),
				"%s %s did not produce auth.Middleware's specific refusal", route.Method, route.Path)
		})
	}

	// A guard against the allowlist and the router silently drifting apart
	// (e.g. every /v1 route getting removed and this test passing on zero
	// iterations). If this ever fires, something upstream of route discovery
	// broke, not the auth guarantee itself.
	if checked == 0 {
		t.Fatal("no non-allowlisted /v1 routes were discovered — route discovery is broken")
	}
	if allowlisted == 0 {
		t.Fatal("no allowlisted /v1 routes were discovered — the admin groups are not being mounted for this test")
	}
}
