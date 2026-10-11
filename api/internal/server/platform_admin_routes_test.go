package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/platformauth"
)

// These tests are about the SEAM, not about any handler's body: that the
// contract routes are mounted where the federation client will look for them,
// that they sit behind platformauth rather than bffauth, and that the two
// callers cannot reach each other's routes.
//
// Every one of them stops at the middleware. A request that gets past
// platformauth here reaches a handler holding a zero *gorm.DB and panics or
// 500s — which is fine and is the point: 404 vs 401 vs "past the gate" is
// what is being asserted. Handler bodies are tested in package platformadmin.

const platformTestSecret = "platform-test-secret-0123456789"

// contractRoutes is every path the contract surface mounts. Listed once so a
// route added without a test is visible here rather than discovered by the
// console.
var contractRoutes = []string{
	"/v1/admin/audit-logs",
	"/v1/admin/inbox",
	"/v1/admin/entities/users",
	"/v1/admin/health",
	"/v1/admin/kpis",
	"/v1/admin/ai-metrics",
}

// signPlatform builds a request the federation client would recognise as its
// own. It signs the FULL path including /v1 — which is the whole reason the
// registered BaseURL must end in "/v1"; see platformadmin.Register.
func signPlatform(t *testing.T, target string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)

	in := platformauth.SignatureInput{
		Method:     http.MethodGet,
		Path:       req.URL.Path,
		RawQuery:   req.URL.RawQuery,
		Timestamp:  strconv.FormatInt(time.Now().Unix(), 10),
		Nonce:      uuid.NewString(),
		Operator:   "op_7f3a",
		Capability: "audit.read",
	}
	sig, err := platformauth.Sign(platformTestSecret, in)
	require.NoError(t, err)

	req.Header.Set(platformauth.HeaderTimestamp, in.Timestamp)
	req.Header.Set(platformauth.HeaderNonce, in.Nonce)
	req.Header.Set(platformauth.HeaderOperator, in.Operator)
	req.Header.Set(platformauth.HeaderCapability, in.Capability)
	req.Header.Set(platformauth.HeaderSignature, sig)
	return req
}

// signBFF builds a request the tesserix-home ADMIN PORTAL would send: the
// other scheme, correctly signed with its own key.
func signBFF(t *testing.T, key []byte, target string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	id := bffauth.Identity{
		UserID: "admin-1", Email: "a@b.com",
		Role: bffauth.RoleAdmin, Pool: bffauth.PoolInternal,
	}

	req.Header.Set(bffauth.HdrAuthTs, ts)
	req.Header.Set(bffauth.HdrUserID, id.UserID)
	req.Header.Set(bffauth.HdrUserEmail, id.Email)
	req.Header.Set(bffauth.HdrUserRole, id.Role)
	req.Header.Set(bffauth.HdrAuthPool, id.Pool)
	req.Header.Set(bffauth.HdrSignature,
		bffauth.Compute(http.MethodGet, req.URL.Path, nil, ts, key, id))
	return req
}

// platformRouterOn builds the real router against the test database and
// clears the nonce rows the requests will write.
//
// Unlike the repository suites in package platformadmin, these tests cannot
// run inside a transaction: the router owns its own *gorm.DB and the nonce
// claim is a separate statement. So they clean up after themselves instead —
// without this, every run leaves rows in platform_request_nonces and the
// shared test database grows a table nothing ever reads.
func platformRouterOn(t *testing.T) http.Handler {
	t.Helper()
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM platform_request_nonces") })
	return NewRouter(Deps{
		DB: db, Verifier: stubVerifier{},
		PlatformAdminSecret: platformTestSecret,
	})
}

func serve(r http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// TestContractRoutesAreNotMountedWithoutASecret — an unconfigured environment
// must answer 404, not 401. The difference is what tells an operator whether
// the deploy is missing a secret or the secret is wrong.
func TestContractRoutesAreNotMountedWithoutASecret(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})

	for _, path := range contractRoutes {
		t.Run(path, func(t *testing.T) {
			assert.Equal(t, http.StatusNotFound, serve(r, signPlatform(t, path)).Code)
		})
	}
}

// TestContractRoutesRejectAnUnsignedCaller — the surface carries every user
// record; an unsigned request must never reach a handler.
func TestContractRoutesRejectAnUnsignedCaller(t *testing.T) {
	r := NewRouter(Deps{
		DB: &gorm.DB{}, Verifier: stubVerifier{},
		PlatformAdminSecret: platformTestSecret,
	})

	for _, path := range contractRoutes {
		t.Run(path, func(t *testing.T) {
			rec := serve(r, httptest.NewRequest(http.MethodGet, path, nil))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.Contains(t, rec.Body.String(), "unauthenticated")
		})
	}
}

// TestContractRoutesRejectTheOtherSchemesSignature is the seam this whole
// branch exists for. #430 claimed "transport and identity are solved" because
// /v1/admin was already HMAC-protected — but the portal and the console sign
// byte-incompatible canonical strings, so a correctly-signed portal request
// is not a credential here at all.
func TestContractRoutesRejectTheOtherSchemesSignature(t *testing.T) {
	bffKey := []byte(adminTestKey)
	r := NewRouter(Deps{
		DB: &gorm.DB{}, Verifier: stubVerifier{},
		BFFHMACKey:          bffKey,
		PlatformAdminSecret: platformTestSecret,
	})

	for _, path := range contractRoutes {
		t.Run(path, func(t *testing.T) {
			rec := serve(r, signBFF(t, bffKey, path))
			assert.Equal(t, http.StatusUnauthorized, rec.Code,
				"a portal signature must not authenticate a console route")
		})
	}
}

// TestPortalRoutesRejectThePlatformSignature is the same seam from the other
// side: mounting a second group on /v1/admin must not weaken the first.
func TestPortalRoutesRejectThePlatformSignature(t *testing.T) {
	r := NewRouter(Deps{
		DB: &gorm.DB{}, Verifier: stubVerifier{},
		BFFHMACKey:          []byte(adminTestKey),
		PlatformAdminSecret: platformTestSecret,
	})

	for _, path := range []string{"/v1/admin/events", "/v1/admin/users", "/v1/admin/foods"} {
		t.Run(path, func(t *testing.T) {
			rec := serve(r, signPlatform(t, path))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

// TestBothGroupsCoexistOnTheSamePrefix — gin's radix tree must accept two
// groups rooted at /v1/admin with different middleware. If it ever panics on
// registration this fails at NewRouter, which is the earliest possible place
// to find out.
func TestBothGroupsCoexistOnTheSamePrefix(t *testing.T) {
	r := NewRouter(Deps{
		DB: &gorm.DB{}, Verifier: stubVerifier{},
		BFFHMACKey:          []byte(adminTestKey),
		PlatformAdminSecret: platformTestSecret,
	})

	// Both sets exist: neither answers 404, and each rejects the other's
	// caller with 401 rather than swallowing it.
	assert.Equal(t, http.StatusUnauthorized,
		serve(r, httptest.NewRequest(http.MethodGet, "/v1/admin/audit-logs", nil)).Code)
	assert.Equal(t, http.StatusUnauthorized,
		serve(r, httptest.NewRequest(http.MethodGet, "/v1/admin/events", nil)).Code)
}

// TestASignedPlatformRequestReachesTheContractHandler is the end-to-end
// proof, and the mirror of the bffauth one further down router_test.go: a
// request signed exactly the way the console's federation client signs it
// must reach a contract handler through the real router, past the real nonce
// store.
//
// /admin/kpis is the route driven here because its answer needs no rows — so
// the assertion is about the SEAM (routing, middleware, nonce claim) and can
// never pass or fail on what happens to be in the shared test database.
func TestASignedPlatformRequestReachesTheContractHandler(t *testing.T) {
	r := platformRouterOn(t)

	rec := serve(r, signPlatform(t, "/v1/admin/kpis"))

	require.Equal(t, http.StatusNotImplemented, rec.Code,
		"a correctly signed request must reach the handler, and the handler's answer is 501")
	assert.Contains(t, rec.Body.String(), "not_implemented")
}

// TestAReplayedPlatformRequestIsRejectedByTheRealRouter proves the nonce
// store is actually wired, not merely constructed. Replay defence that is
// built but not reached looks identical to replay defence that works, until
// someone replays a request.
func TestAReplayedPlatformRequestIsRejectedByTheRealRouter(t *testing.T) {
	r := platformRouterOn(t)

	req := signPlatform(t, "/v1/admin/kpis")
	// Two identical requests: same signature, same nonce, same window.
	replay := req.Clone(req.Context())

	require.Equal(t, http.StatusNotImplemented, serve(r, req).Code)
	assert.Equal(t, http.StatusUnauthorized, serve(r, replay).Code)
}

// TestTheSignatureCoversTheQueryString — bffauth signs a bare path, this
// scheme signs a canonical query too, and nothing else in this repo pins the
// difference. A verifier that dropped RawQuery would pass every other test
// here and 401 in production on the first fan-out, which always sends
// ?limit=&since_hours=.
func TestTheSignatureCoversTheQueryString(t *testing.T) {
	r := platformRouterOn(t)

	signed := signPlatform(t, "/v1/admin/kpis?keys=a&keys=b")
	require.Equal(t, http.StatusNotImplemented, serve(r, signed).Code)

	tampered := signPlatform(t, "/v1/admin/kpis?keys=a&keys=b")
	tampered.URL.RawQuery = "keys=a&keys=c"
	assert.Equal(t, http.StatusUnauthorized, serve(r, tampered).Code)
}
