package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/resolve"
)

func TestHealthEndpoint(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/health", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestUnknownRouteReturnsEnvelope(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/nope", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.JSONEq(t, `{"error":"not_found","message":"route not found"}`, w.Body.String())
}

type stubVerifier struct{}

func (stubVerifier) Verify(ctx context.Context, idToken string) (auth.Claims, error) {
	return auth.Claims{}, nil
}

func hasRoute(routes gin.RoutesInfo, method, path string) bool {
	for _, r := range routes {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}

func TestResolveRoutesRegisteredWhenResolverSet(t *testing.T) {
	h := resolve.NewHandler(nil, nil) // never invoked — we only inspect registration
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, Resolver: &h})
	routes := r.Routes()
	for _, p := range []string{"/v1/resolve/text", "/v1/resolve/photo", "/v1/resolve/voice", "/v1/resolve/barcode"} {
		if !hasRoute(routes, "POST", p) {
			t.Errorf("expected POST %s to be registered", p)
		}
	}
}

func TestLogUpdateRouteRegistered(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	if !hasRoute(r.Routes(), "PATCH", "/v1/logs/:id") {
		t.Error("expected PATCH /v1/logs/:id to be registered")
	}
}

func TestResolveRoutesAbsentWhenResolverNil(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}}) // Resolver nil
	if hasRoute(r.Routes(), "POST", "/v1/resolve/text") {
		t.Error("resolve routes must not be registered when Resolver is nil")
	}
	if hasRoute(r.Routes(), "POST", "/v1/resolve/voice") {
		t.Error("resolve voice route must not be registered when Resolver is nil")
	}
}

// testDB opens a real connection to the local test database, mirroring
// internal/admin/repository_test.go's helper. Route-registration tests above
// use a bare &gorm.DB{} because they never execute a query — but the
// end-to-end admin tests below actually hit the handler, which runs SQL, so
// they need a live connection. Skips (not fails) when TEST_DATABASE_URL is
// unset, matching the rest of the suite's local/CI split.
func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

// The end-to-end proof of the signed path: a request signed exactly the way
// tesserix-home signs it must reach the admin handler through the real router.
// Every other test in this plan exercises one side; this one joins them.
// Assert only that the request reaches the handler (200, well-formed
// envelope) — never a row count. CI runs only cmd/migrate, so food_items is
// EMPTY there while the local database holds ambient rows; an assertion tied
// to a count would pass here and fail in CI.
func TestAdminFoodsIsReachableWithAValidSignature(t *testing.T) {
	key := []byte("kora-test-hmac-key-123456")
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}, BFFHMACKey: key})

	const path = "/v1/admin/foods"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	id := bffauth.Identity{UserID: "admin-uid-1", Email: "admin@tesserix.app", Role: "admin", Pool: "internal"}

	req := httptest.NewRequest(http.MethodGet, path+"?limit=1", nil)
	req.Header.Set(bffauth.HdrUserID, id.UserID)
	req.Header.Set(bffauth.HdrUserEmail, id.Email)
	req.Header.Set(bffauth.HdrUserRole, id.Role)
	req.Header.Set(bffauth.HdrAuthPool, id.Pool)
	req.Header.Set(bffauth.HdrAuthTs, ts)
	// Signed over the PATH ONLY — the query string is excluded, matching
	// r.URL.Path on the server and the TS client's `path` argument. If either
	// side ever includes the query, this test goes red instead of production.
	req.Header.Set(bffauth.HdrSignature, bffauth.Compute(http.MethodGet, path, nil, ts, key, id))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// The twin: the same route with NO signature must 401, proving the middleware
// is actually attached to it rather than the route being public.
func TestAdminFoodsRejectsAnUnsignedRequest(t *testing.T) {
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}, BFFHMACKey: []byte("kora-test-hmac-key-123456")})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// A Firebase bearer token — an END USER's credential — must not open the admin
// surface. The two auth systems are disjoint and this pins that.
func TestAdminFoodsRejectsAFirebaseBearerToken(t *testing.T) {
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}, BFFHMACKey: []byte("kora-test-hmac-key-123456")})

	req := httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil)
	req.Header.Set("Authorization", "Bearer any-valid-user-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// With no key configured the routes must not exist at all — 404, not 401.
// A 401 would mean the surface is mounted and merely unauthenticated.
func TestAdminFoodsIsUnmountedWithoutAKey(t *testing.T) {
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}
