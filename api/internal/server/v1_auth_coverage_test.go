package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"gorm.io/gorm"

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
// v1AuthAllowlist is the load-bearing part. Every route under /v1 that is NOT
// behind auth.Middleware must be listed here, each with a comment stating
// exactly why it is exempt. Adding a route outside the authenticated group
// must be a decision someone writes down, not an omission this test lets
// slide.
var v1AuthAllowlist = map[string]string{
	// /v1/admin/* (tesserix-home admin portal). Mounted on its OWN group in
	// router.go (`r.Group("/v1/admin", bffauth.Middleware(...))`), separate
	// from the Firebase-authed `v1` group: the caller is a platform admin
	// signing an HMAC request, never a Firebase end user. An unauthenticated
	// request here is still refused — bffauth.Middleware answers 401
	// "invalid or missing signature" — just not with auth.Middleware's
	// "invalid or missing token" body this test checks for elsewhere.
	"GET /v1/admin/foods":          "bffauth-signed admin portal route, not Firebase auth",
	"GET /v1/admin/foods/:id":      "bffauth-signed admin portal route, not Firebase auth",
	"GET /v1/admin/events":         "bffauth-signed admin portal route, not Firebase auth",
	"POST /v1/admin/foods":         "bffauth-signed admin portal route, not Firebase auth",
	"PATCH /v1/admin/foods/:id":    "bffauth-signed admin portal route, not Firebase auth",
	"DELETE /v1/admin/foods/:id":   "bffauth-signed admin portal route, not Firebase auth",
	"GET /v1/admin/feedback":       "bffauth-signed admin portal route, not Firebase auth",
	"PATCH /v1/admin/feedback/:id": "bffauth-signed admin portal route, not Firebase auth",
	"GET /v1/admin/users":          "bffauth-signed admin portal route, not Firebase auth",
	"GET /v1/admin/users/:id":      "bffauth-signed admin portal route, not Firebase auth",
	"DELETE /v1/admin/users/:id":   "bffauth-signed admin portal route, not Firebase auth",

	// /v1/admin/* (platform console). A SECOND group on the same prefix
	// (platformadmin.Register), behind platformauth instead of bffauth — see
	// that package's doc for why the portal and the console cannot share one
	// scheme. An unsigned caller is still refused (401 "unauthenticated"),
	// again just not with auth.Middleware's body.
	"GET /v1/admin/audit-logs":                   "platformauth-signed console route, not Firebase auth",
	"GET /v1/admin/inbox":                        "platformauth-signed console route, not Firebase auth",
	"GET /v1/admin/entities/:type":               "platformauth-signed console route, not Firebase auth",
	"GET /v1/admin/health":                       "platformauth-signed console route, not Firebase auth",
	"GET /v1/admin/kpis":                         "platformauth-signed console route, not Firebase auth",
	"GET /v1/admin/ai-metrics":                   "platformauth-signed console route, not Firebase auth",
	"POST /v1/admin/inbox/:id/actions/:actionId": "platformauth-signed console route, not Firebase auth",
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

// TestEveryV1RouteRequiresAuthUnlessAllowlisted is the route-wide assertion
// kora#371 asks for. It discovers every /v1 route the router actually
// registers (rather than a hand-maintained list, which is exactly what let
// the gap in #371 go unnoticed) and, for each one, either:
//
//   - confirms an unauthenticated request gets auth.Middleware's specific
//     401 refusal, or
//   - requires the route to be named in v1AuthAllowlist with a reason.
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
	})

	routes := r.Routes()
	checked := 0
	for _, route := range routes {
		if !strings.HasPrefix(route.Path, "/v1") {
			continue
		}
		key := route.Method + " " + route.Path
		if reason, ok := v1AuthAllowlist[key]; ok {
			t.Run(key+"/allowlisted", func(t *testing.T) {
				if reason == "" {
					t.Fatalf("%s is allowlisted with no reason — every exemption must say why", key)
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
}
