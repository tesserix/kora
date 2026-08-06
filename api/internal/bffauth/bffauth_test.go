package bffauth

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testKeyB64 decodes to "kora-test-hmac-key-123456" (25 bytes, over the
// 16-byte floor). The same constant is used by the drift vector below and by
// tesserix-home's lib/api/kora-admin.test.ts.
const testKeyB64 = "a29yYS10ZXN0LWhtYWMta2V5LTEyMzQ1Ng=="

func testKey(t *testing.T) []byte {
	t.Helper()
	k, err := base64.StdEncoding.DecodeString(testKeyB64)
	require.NoError(t, err)
	return k
}

func adminIdentity() Identity {
	return Identity{
		UserID: "admin-uid-1",
		Email:  "admin@tesserix.app",
		Role:   "admin",
		Pool:   "internal",
	}
}

// TestComputePinsTheCanonicalString is the CROSS-REPO DRIFT GUARD. The expected
// value is not "whatever the code produces" — it is a fixed vector that
// tesserix-home's computeSignature test pins to the identical constant. If
// either side changes field order, separators, or the body hash encoding, one
// of the two tests goes red instead of the whole admin surface silently 401ing
// in production.
func TestComputePinsTheCanonicalString(t *testing.T) {
	got := Compute(
		http.MethodGet, "/v1/admin/foods", nil, "1735689600",
		testKey(t), adminIdentity(),
	)
	assert.Equal(t,
		"592716969fc5d8c9c0b8013ca2027ae3318d02dd31a59868749a7d2dc2aa3ac7",
		got,
	)
}

// TestComputePinsTheCanonicalStringWithBody is the second half of the
// cross-repo drift guard. TestComputePinsTheCanonicalString above signs a nil
// body, so it cannot catch a change to HOW the body is hashed: Compute is
// used by both the test's signing helper and the verifier, so a symmetric
// change to the body-hashing step (e.g. hashing something derived from the
// body instead of the body itself) is invisible to every other test in this
// file. Signing a non-empty, non-trivial body here closes that gap. The body
// uses non-ASCII characters to pin UTF-8 byte encoding: a client that hashed
// the string as latin-1 would produce digest 4a2998d2265e54286e1f76af69455861d80411a2f4cff7f3ca2954102b3117d4,
// completely different, and fail here rather than 401ing in production on the
// first food with an accent. The expected value is a fixed vector shared with
// tesserix-home's kora-admin.test.ts — if either side changes field order,
// separators, or the body hash encoding, one of the two tests goes red instead
// of the whole admin surface silently 401ing in production.
func TestComputePinsTheCanonicalStringWithBody(t *testing.T) {
	got := Compute(
		http.MethodPost, "/v1/admin/foods", []byte(`{"name":"crème brûlée","kcal":257}`), "1735689600",
		testKey(t), adminIdentity(),
	)
	assert.Equal(t,
		"c0328fe10ebf9e64f71f51d007abd65eb0b902bdefab3279033c1cb1d4019ac3",
		got,
	)
}

// signedRequest builds a request signed over exactly the values it carries, so
// each tampering test below can change one thing and be sure that one thing is
// what broke it.
func signedRequest(t *testing.T, key []byte, method, path, body string, id Identity, ts time.Time) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	stamp := strconv.FormatInt(ts.Unix(), 10)
	req.Header.Set(HdrUserID, id.UserID)
	req.Header.Set(HdrUserEmail, id.Email)
	req.Header.Set(HdrUserRole, id.Role)
	req.Header.Set(HdrAuthPool, id.Pool)
	req.Header.Set(HdrAuthTs, stamp)
	req.Header.Set(HdrSignature, Compute(method, path, []byte(body), stamp, key, id))
	return req
}

func router(key []byte) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 60*time.Second))
	handle := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"id":    c.GetString(CtxAdminID),
			"email": c.GetString(CtxAdminEmail),
		})
	}
	r.GET("/v1/admin/foods", handle)
	r.POST("/v1/admin/foods", handle)
	return r
}

// The positive twin for every rejection test below. Without it, a middleware
// that rejected EVERYTHING would pass the entire rest of this file.
func TestMiddlewareAcceptsAValidSignatureAndExposesTheIdentity(t *testing.T) {
	key := testKey(t)
	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now()))

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"id":"admin-uid-1","email":"admin@tesserix.app"}`, w.Body.String())
}

// There is no dedicated "missing signature" guard in verify(): an absent
// signature is simply the empty string, which never equals Compute's output,
// so hmac.Equal below rejects it the same way it rejects any other wrong
// signature.
func TestMiddlewareRejectsMissingSignature(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	req.Header.Del(HdrSignature)

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestMiddlewareRejectsTamperedBody(t *testing.T) {
	key := testKey(t)
	// Signed over one body, delivered with another. Built as a fresh request
	// carrying the original's headers, so the ONLY difference is the body.
	signed := signedRequest(t, key, http.MethodPost, "/v1/admin/foods", `{"name":"oats"}`, adminIdentity(), time.Now())
	replay := httptest.NewRequest(http.MethodPost, "/v1/admin/foods", strings.NewReader(`{"name":"quinoa"}`))
	replay.Header = signed.Header

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, replay)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// The twin: the SAME body it was signed over must pass, or the test above
// would also pass against a middleware that rejected every POST.
func TestMiddlewareAcceptsTheBodyItWasSignedOver(t *testing.T) {
	key := testKey(t)
	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, signedRequest(t, key, http.MethodPost, "/v1/admin/foods", `{"name":"oats"}`, adminIdentity(), time.Now()))
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestMiddlewareRejectsTamperedPath(t *testing.T) {
	key := testKey(t)
	// Signed for /v1/admin/foods, replayed against a different registered route.
	signed := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	replay := httptest.NewRequest(http.MethodGet, "/v1/admin/other", nil)
	replay.Header = signed.Header

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 60*time.Second))
	r.GET("/v1/admin/other", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, replay)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestMiddlewareRejectsTamperedMethod(t *testing.T) {
	key := testKey(t)
	signed := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	replay := httptest.NewRequest(http.MethodPost, "/v1/admin/foods", strings.NewReader(""))
	replay.Header = signed.Header

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, replay)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// The identity-binding property: a signature is only valid for the identity it
// was computed over, so a captured request cannot be replayed with a different
// role or pool asserted in the headers.
func TestMiddlewareRejectsSwappedRoleHeader(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	req.Header.Set(HdrUserRole, "superadmin")

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestMiddlewareRejectsSwappedPoolHeader(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	req.Header.Set(HdrAuthPool, "customer")

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestMiddlewareRejectsStaleTimestamp(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now().Add(-90*time.Second))

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestMiddlewareRejectsFutureTimestamp(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now().Add(90*time.Second))

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// A timestamp INSIDE the window must pass, or the two tests above would also
// pass against a middleware that rejected every timestamp.
func TestMiddlewareAcceptsTimestampInsideWindow(t *testing.T) {
	key := testKey(t)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now().Add(-30*time.Second))

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// TestMiddlewareStopsTheChainOnRejection is the CRITICAL abort-path guard.
// httpx.Error happens to call gin's AbortWithStatusJSON internally, but this
// package neither states nor tests that anywhere else: every other rejection
// test in this file only asserts the response status code, so a
// c.JSON(...)+return that forgot to abort would still return 401 while the
// downstream handler ran anyway. A later slice mounts writes and deletes
// behind this middleware, so that gap would mean every unsigned request
// reaches the admin handler with CI green. This test proves the chain
// actually stops by asserting a probe handler never runs.
func TestMiddlewareStopsTheChainOnRejection(t *testing.T) {
	key := testKey(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 60*time.Second))
	reached := false
	r.GET("/v1/admin/foods", func(c *gin.Context) {
		reached = true
		c.Status(http.StatusOK)
	})

	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	req.Header.Del(HdrSignature)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.False(t, reached, "handler ran despite an unsigned request: the middleware answered 401 without aborting the chain")
}

// A CORRECTLY SIGNED non-admin is 403, not 401 — the signature verified, the
// authorization did not. Distinct codes keep the two failures distinguishable
// in production, where 401 means "key or clock problem" and 403 means "this
// caller is not an admin". This is also the SECOND abort path (alongside
// TestMiddlewareStopsTheChainOnRejection above): the 403 guard must stop the
// chain too, since a later slice's writes/deletes sit behind it.
func TestMiddlewareRejectsCorrectlySignedNonAdmin(t *testing.T) {
	key := testKey(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 60*time.Second))
	reached := false
	r.GET("/v1/admin/foods", func(c *gin.Context) {
		reached = true
		c.Status(http.StatusOK)
	})

	id := adminIdentity()
	id.Role = "customer"
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", id, time.Now())

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.False(t, reached, "handler ran despite a non-admin identity: the 403 guard did not abort the chain")
}

// TestMiddlewareRejectsCorrectlySignedWrongPool proves PoolInternal is
// enforced, not just documented. Pool is bound into the MAC, so this isn't a
// security hole either way — but before this fix, the guard checked Role and
// UserID only, so a reader could believe Pool was enforced when it was not.
// TestMiddlewareAcceptsAValidSignatureAndExposesTheIdentity (pool "internal")
// is this test's twin: it must keep passing, or this guard would reject
// every pool, not just the wrong one.
func TestMiddlewareRejectsCorrectlySignedWrongPool(t *testing.T) {
	key := testKey(t)
	id := adminIdentity()
	id.Pool = "mp-internal"
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", id, time.Now())

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestMiddlewareRejectsCorrectlySignedEmptyUserID(t *testing.T) {
	key := testKey(t)
	id := adminIdentity()
	id.UserID = ""
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", id, time.Now())

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)
}

// TestMiddlewareRejectsCorrectlySignedEmptyEmail is IMPORTANT 3's fix: Email
// is bound into the MAC (see Compute), so a correctly-signed request can
// still carry X-User-Email: "". Before this guard, that request authenticated
// cleanly and only failed later when kora_admin_events' actor_email CHECK
// aborted the mutation transaction with a 500 — fail-closed and correct, but
// a much worse failure than rejecting the unattributable caller here with a
// clear 403, the same way the empty-UserID guard above already does.
func TestMiddlewareRejectsCorrectlySignedEmptyEmail(t *testing.T) {
	key := testKey(t)
	id := adminIdentity()
	id.Email = ""
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", id, time.Now())

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusForbidden, w.Code)
}

// The twin: a request with a non-empty email must still succeed, or the test
// above would also pass against a guard that rejected every request
// regardless of Email. Uses the same adminIdentity() as
// TestMiddlewareAcceptsAValidSignatureAndExposesTheIdentity, restated here so
// this test stays meaningful even if that one is ever changed or removed.
func TestMiddlewareAcceptsCorrectlySignedNonEmptyEmail(t *testing.T) {
	key := testKey(t)
	id := adminIdentity()
	require.NotEmpty(t, id.Email)
	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", id, time.Now())

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// The body must survive verification: the middleware reads it to re-hash it,
// so a handler downstream must still be able to read it in full.
func TestMiddlewareRestoresTheBodyForDownstreamHandlers(t *testing.T) {
	key := testKey(t)
	const body = `{"name":"oats"}`
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 60*time.Second))
	var seen string
	r.POST("/v1/admin/foods", func(c *gin.Context) {
		b, _ := c.GetRawData()
		seen = string(b)
		c.Status(http.StatusOK)
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedRequest(t, key, http.MethodPost, "/v1/admin/foods", body, adminIdentity(), time.Now()))

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, body, seen)
}

// TestMiddlewareWithZeroWindowUsesDefaultWindow pins that window<=0 means
// DefaultWindow, not "no window" or "zero tolerance". Every other test in
// this file passes 60*time.Second explicitly, so deleting the fallback in
// Middleware would leave the rest of the suite green — but the router task
// that mounts this middleware calls Middleware(key, 0) deliberately, making
// this fallback load-bearing in production. A recent timestamp must succeed
// under window 0.
func TestMiddlewareWithZeroWindowUsesDefaultWindow(t *testing.T) {
	key := testKey(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 0))
	r.GET("/v1/admin/foods", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now().Add(-30*time.Second))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// The twin: a timestamp outside DefaultWindow (60s) must still be rejected
// under window 0. Without this, the test above would also pass against a
// "0 means no freshness check at all" interpretation of the fallback.
// Together the pair pin window<=0 to DefaultWindow specifically.
func TestMiddlewareWithZeroWindowRejectsStaleTimestamp(t *testing.T) {
	key := testKey(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(key, 0))
	r.GET("/v1/admin/foods", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now().Add(-90*time.Second))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// TestMiddlewareRejectsBodyExceedingHardCap proves the pre-authentication
// body read is bounded: a body larger than maxAdminBodyBytes must trip
// http.MaxBytesReader and land on the existing errBodyRead -> 400 branch, not
// 401. A 401 here would send an operator hunting a key mismatch that does
// not exist, when in fact no credential was ever assessed. The signature
// header value is irrelevant since the body read fails before verification.
func TestMiddlewareRejectsBodyExceedingHardCap(t *testing.T) {
	key := testKey(t)
	oversized := strings.Repeat("a", maxAdminBodyBytes+1)
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/foods", strings.NewReader(oversized))
	req.Header.Set(HdrAuthTs, strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set(HdrSignature, "irrelevant-body-read-fails-first")

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

// The twin: a body just under maxAdminBodyBytes must still be accepted, or
// the test above would also pass against a middleware that rejected every
// body regardless of size.
func TestMiddlewareAcceptsBodyJustUnderHardCap(t *testing.T) {
	key := testKey(t)
	body := strings.Repeat("a", maxAdminBodyBytes-1)
	req := signedRequest(t, key, http.MethodPost, "/v1/admin/foods", body, adminIdentity(), time.Now())

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// captureLogger installs a JSON slog handler over a buffer as the process
// default logger for the duration of the test, and restores the previous
// default on cleanup. Mirrors internal/server/logging_test.go's helper of
// the same name; duplicated locally rather than imported so this package's
// tests don't reach across a package boundary for a five-line helper.
func captureLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// rejectReason runs req through a fresh router, requires a 401, and returns
// the "reason" field of the single log line the rejection produced along
// with the raw line, so callers can also assert on what the line does NOT
// contain.
func rejectReason(t *testing.T, key []byte, req *http.Request) (reason, rawLine string) {
	t.Helper()
	buf := captureLogger(t)

	w := httptest.NewRecorder()
	router(key).ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	require.Len(t, lines, 1, "expected exactly one log line, got: %q", buf.String())
	rawLine = lines[0]

	var entry map[string]any
	require.NoError(t, json.Unmarshal([]byte(rawLine), &entry))
	got, ok := entry["reason"].(string)
	require.True(t, ok, "log line missing string \"reason\" field: %v", entry)
	return got, rawLine
}

// TestMiddlewareLogsADistinctReasonPerRejectionCause is IMPORTANT 1's fix: a
// wrong key, a clock-skewed timestamp, and a missing/malformed timestamp all
// answer the client with the identical vague 401 (and must keep doing so —
// the wire contract is pinned cross-repo), but an operator reading
// `kubectl logs` needs to tell them apart. This test proves the server-side
// log line actually distinguishes all three, and — just as importantly —
// that the log line never echoes the header values that caused the
// rejection (the actual bad signature, the actual stale timestamp).
func TestMiddlewareLogsADistinctReasonPerRejectionCause(t *testing.T) {
	key := testKey(t)
	const forgedSig = "0000000000000000000000000000000000000000000000000000000000000000"

	wrongKeyReq := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	wrongKeyReq.Header.Set(HdrSignature, forgedSig)

	staleTs := time.Now().Add(-90 * time.Second)
	staleReq := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), staleTs)

	// Deleted AFTER signing: the timestamp parse failure must be caught
	// before the signature is even compared, so what was signed over is
	// irrelevant here — only the header's absence matters.
	missingTsReq := signedRequest(t, key, http.MethodGet, "/v1/admin/foods", "", adminIdentity(), time.Now())
	missingTsReq.Header.Del(HdrAuthTs)

	wrongKeyReason, wrongKeyLine := rejectReason(t, key, wrongKeyReq)
	staleReason, staleLine := rejectReason(t, key, staleReq)
	missingTsReason, missingTsLine := rejectReason(t, key, missingTsReq)

	assert.Equal(t, "signature_mismatch", wrongKeyReason)
	assert.Equal(t, "stale_timestamp", staleReason)
	assert.Equal(t, "bad_timestamp", missingTsReason)

	// Belt-and-suspenders: even if the exact reason strings above ever
	// change, the three causes must never collapse back into one value.
	assert.NotEqual(t, wrongKeyReason, staleReason)
	assert.NotEqual(t, wrongKeyReason, missingTsReason)
	assert.NotEqual(t, staleReason, missingTsReason)

	// The log must not leak what caused the rejection: neither the forged
	// signature value nor the actual stale timestamp value appears anywhere
	// in the line — only the category. Also check the admin identity
	// (carried in plain headers on every one of these requests, including
	// the missing-timestamp one) never leaks into any of the three lines.
	assert.NotContains(t, wrongKeyLine, forgedSig)
	assert.NotContains(t, staleLine, strconv.FormatInt(staleTs.Unix(), 10))
	for _, line := range []string{wrongKeyLine, staleLine, missingTsLine} {
		assert.NotContains(t, line, adminIdentity().Email)
	}
}
