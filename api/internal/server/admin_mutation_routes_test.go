package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/bffauth"
)

const adminTestKey = "kora-test-hmac-key-123456"

func adminTestIdentity() bffauth.Identity {
	return bffauth.Identity{UserID: "admin-uid-1", Email: "admin@tesserix.app", Role: "admin", Pool: "internal"}
}

// signedAdminRequest signs over exactly the method, path and body it carries,
// the same way tesserix-home's client does.
func signedAdminRequest(t *testing.T, key []byte, method, path, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	id := adminTestIdentity()
	req.Header.Set(bffauth.HdrUserID, id.UserID)
	req.Header.Set(bffauth.HdrUserEmail, id.Email)
	req.Header.Set(bffauth.HdrUserRole, id.Role)
	req.Header.Set(bffauth.HdrAuthPool, id.Pool)
	req.Header.Set(bffauth.HdrAuthTs, ts)
	req.Header.Set(bffauth.HdrSignature, bffauth.Compute(method, path, []byte(body), ts, key, id))
	return req
}

// THE MUTATION-VERIFY THE TASK BRIEF NAMES EXPLICITLY: an unsigned mutation
// must be 401 — not 404 (which would mean the route was never mounted, so
// the test would pass for the wrong reason and keep passing if auth were
// removed) and emphatically not 200. Each verb is asserted separately
// because they are three separate registrations: attaching the middleware to
// the group protects all three at once today, but a future refactor that
// mounted one of them outside the group would be invisible to a test that
// only checked DELETE.
//
// Uses a bare &gorm.DB{}: bffauth.Middleware rejects before any handler
// runs, so no query is issued — and, more importantly, this test must not be
// able to SKIP itself if TEST_DATABASE_URL goes missing. A skipped auth test
// is an unprotected admin surface under a green build.
func TestAdminFoodMutationRoutesRejectUnsignedRequests(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: []byte(adminTestKey)})
	id := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/v1/admin/foods"},
		{http.MethodPatch, "/v1/admin/foods/" + id},
		{http.MethodDelete, "/v1/admin/foods/" + id},
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{"name":"anything"}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)

		assert.Equal(t, http.StatusUnauthorized, w.Code,
			"%s %s must be 401 (mounted and protected), not 404 (never mounted) or 200 (open)", tc.method, tc.path)
	}
}

// A signature valid for one method or path must not open another. Without
// this, "the route is behind bffauth" could be satisfied by a middleware
// that verified the signature against something other than THIS request —
// and a DELETE replayed from a captured GET signature would retire a food.
func TestAdminFoodMutationSignatureIsBoundToMethodAndPath(t *testing.T) {
	key := []byte(adminTestKey)
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: key})
	id := uuid.New().String()
	target := "/v1/admin/foods/" + id

	// Signed as a GET of the LIST path, replayed as a DELETE of one food.
	req := signedAdminRequest(t, key, http.MethodGet, "/v1/admin/foods", "")
	replay := httptest.NewRequest(http.MethodDelete, target, nil)
	replay.Header = req.Header.Clone()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, replay)
	assert.Equal(t, http.StatusUnauthorized, w.Code, "a GET signature must not authorise a DELETE")

	// Correctly signed for the method but for a DIFFERENT food's path.
	other := signedAdminRequest(t, key, http.MethodDelete, "/v1/admin/foods/"+uuid.New().String(), "")
	crossPath := httptest.NewRequest(http.MethodDelete, target, nil)
	crossPath.Header = other.Header.Clone()
	w = httptest.NewRecorder()
	r.ServeHTTP(w, crossPath)
	assert.Equal(t, http.StatusUnauthorized, w.Code, "a signature for another food's path must not authorise this one")
}

// A tampered BODY must not verify either. This is the mutation-specific half
// of the signature guard: the read surface has no body, so nothing in the
// existing suite pins that the body is covered on the write path — where an
// attacker rewriting macros in flight is the actual threat.
func TestAdminFoodCreateSignatureCoversTheBody(t *testing.T) {
	key := []byte(adminTestKey)
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: key})

	signed := signedAdminRequest(t, key, http.MethodPost, "/v1/admin/foods", `{"name":"oats","kcal_per_100g":389}`)
	tampered := httptest.NewRequest(http.MethodPost, "/v1/admin/foods",
		strings.NewReader(`{"name":"oats","kcal_per_100g":1}`))
	tampered.Header = signed.Header.Clone()

	w := httptest.NewRecorder()
	r.ServeHTTP(w, tampered)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// PATH ENCODING — the trap slice 1 left latent and this task makes live
// (task-5 brief). ":id" is the first path PARAMETER on the admin surface.
// The TypeScript client signs the raw path string, fetch percent-encodes on
// the wire, and Go's URL.Path percent-DECODES before bffauth.verify signs it.
// A UUID is ASCII-safe so the two sides agree — this test pins that they do,
// end to end, through the real router.
//
// It asserts only that the request got PAST the middleware (any status other
// than 401), never the handler's own status: this test is about the
// signature agreeing on the path, and pinning a 404-vs-200 here would couple
// it to whether the food happens to exist in the shared local database.
func TestAdminFoodDeleteWithAWellFormedUUIDVerifies(t *testing.T) {
	key := []byte(adminTestKey)
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}, BFFHMACKey: key})

	path := "/v1/admin/foods/" + uuid.New().String()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, path, ""))

	require.NotEqual(t, http.StatusUnauthorized, w.Code,
		"a signed, well-formed UUID path must verify: the client signs the raw path and Go signs URL.Path")
	assert.Equal(t, http.StatusNotFound, w.Code, "a random UUID is not a food that exists")
}

// The twin, and the answer to the question the brief asks to report on: a
// MALFORMED id produces a clean 400 from the handler, not a 401 (which would
// mean the signature disagreed about the path) and not a 500. It reaches the
// handler because gin routes it as a valid :id segment — gin has no opinion
// about UUID shape, so the validation has to be ours.
func TestAdminFoodDeleteWithAMalformedIDIs400NotAServerError(t *testing.T) {
	key := []byte(adminTestKey)
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: key})

	path := "/v1/admin/foods/not-a-uuid"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, path, ""))

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// With no key configured the MUTATION routes must not exist either — 404,
// not 401. The read surface already pins this; the write surface is where it
// actually matters, because a mounted-but-unauthenticated DELETE is
// destructive rather than merely leaky.
func TestAdminFoodMutationRoutesAreUnmountedWithoutAKey(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	id := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/v1/admin/foods"},
		{http.MethodPatch, "/v1/admin/foods/" + id},
		{http.MethodDelete, "/v1/admin/foods/" + id},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)))
		assert.Equal(t, http.StatusNotFound, w.Code, "%s %s", tc.method, tc.path)
	}
}
