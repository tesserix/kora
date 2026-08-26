package platformauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testSecret = "test-secret"

// fakeNonces is an in-memory NonceStore. Production must not use one (see
// NewNonceStore) — replay defence that works at one replica is not defence —
// but a test process is one replica by definition.
type fakeNonces struct {
	mu       sync.Mutex
	seen     map[string]time.Time
	failWith error
}

func newFakeNonces() *fakeNonces { return &fakeNonces{seen: map[string]time.Time{}} }

func (f *fakeNonces) Claim(_ context.Context, nonce string, expiresAt time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWith != nil {
		return false, f.failWith
	}
	if _, dup := f.seen[nonce]; dup {
		return false, nil
	}
	f.seen[nonce] = expiresAt
	return true, nil
}

// signedRequest builds a request the middleware should accept, so each test
// below can break exactly one thing about it.
func signedRequest(t *testing.T, path, rawQuery string, at time.Time) *http.Request {
	t.Helper()
	ts := strconv.FormatInt(at.Unix(), 10)
	in := SignatureInput{
		Method:     http.MethodGet,
		Path:       path,
		RawQuery:   rawQuery,
		Timestamp:  ts,
		Nonce:      "018f3c2a-0000-7000-8000-000000000abc",
		Operator:   "op_7f3a",
		Capability: "audit.read",
	}
	sig, err := Sign(testSecret, in)
	require.NoError(t, err)

	target := path
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set(HeaderTimestamp, in.Timestamp)
	req.Header.Set(HeaderNonce, in.Nonce)
	req.Header.Set(HeaderOperator, in.Operator)
	req.Header.Set(HeaderCapability, in.Capability)
	req.Header.Set(HeaderSignature, sig)
	return req
}

// router mounts one probe route that reports what the middleware put on the
// context, so an accepted request proves attribution landed rather than only
// proving a 200.
func router(cfg Config) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/probe", Middleware(cfg), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"operator":   c.GetString(CtxOperatorID),
			"capability": c.GetString(CtxCapability),
		})
	})
	return r
}

func fixedConfig(now time.Time, nonces NonceStore) Config {
	return Config{Secret: testSecret, Nonces: nonces, Now: func() time.Time { return now }}
}

func TestMiddlewareAcceptsASignedRequestAndSetsAttribution(t *testing.T) {
	now := time.Unix(1755859200, 0)
	rec := httptest.NewRecorder()
	router(fixedConfig(now, newFakeNonces())).ServeHTTP(rec, signedRequest(t, "/v1/admin/probe", "", now))

	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "op_7f3a", body["operator"])
	assert.Equal(t, "audit.read", body["capability"])
}

// TestMiddlewareAcceptsAQueryString covers the half of the canonical string
// bffauth does not sign at all. A verifier that dropped RawQuery would pass
// every other test in this file.
func TestMiddlewareAcceptsAQueryString(t *testing.T) {
	now := time.Unix(1755859200, 0)
	rec := httptest.NewRecorder()
	req := signedRequest(t, "/v1/admin/probe", "limit=200&since_hours=720", now)
	router(fixedConfig(now, newFakeNonces())).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestMiddlewareRejectsATamperedQueryString(t *testing.T) {
	now := time.Unix(1755859200, 0)
	req := signedRequest(t, "/v1/admin/probe", "limit=200", now)
	// Same signature, different query — the request the signature covers is
	// not the request being served.
	req.URL.RawQuery = "limit=999"

	rec := httptest.NewRecorder()
	router(fixedConfig(now, newFakeNonces())).ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestMiddlewareRejectsAReplayedNonce(t *testing.T) {
	now := time.Unix(1755859200, 0)
	cfg := fixedConfig(now, newFakeNonces())
	r := router(cfg)

	first := httptest.NewRecorder()
	r.ServeHTTP(first, signedRequest(t, "/v1/admin/probe", "", now))
	require.Equal(t, http.StatusOK, first.Code)

	// Byte-identical request. Signature and window both still pass; only the
	// nonce store stands between this and a successful replay.
	second := httptest.NewRecorder()
	r.ServeHTTP(second, signedRequest(t, "/v1/admin/probe", "", now))
	assert.Equal(t, http.StatusUnauthorized, second.Code)
}

// TestMiddlewareRejectsWhenTheNonceStoreErrors — "could not check" must never
// read as "not a replay".
func TestMiddlewareRejectsWhenTheNonceStoreErrors(t *testing.T) {
	now := time.Unix(1755859200, 0)
	nonces := newFakeNonces()
	nonces.failWith = assert.AnError

	rec := httptest.NewRecorder()
	router(fixedConfig(now, nonces)).ServeHTTP(rec, signedRequest(t, "/v1/admin/probe", "", now))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestMiddlewareRejectsAStaleOrFutureTimestamp(t *testing.T) {
	now := time.Unix(1755859200, 0)

	for name, signedAt := range map[string]time.Time{
		"stale":  now.Add(-DefaultWindow - time.Second),
		"future": now.Add(DefaultWindow + time.Second),
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router(fixedConfig(now, newFakeNonces())).
				ServeHTTP(rec, signedRequest(t, "/v1/admin/probe", "", signedAt))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

// TestNonceTTLIsAnchoredToTheSignedTimestamp — a future-dated request inside
// tolerance must expire when IT stops being valid, not when it arrived.
func TestNonceTTLIsAnchoredToTheSignedTimestamp(t *testing.T) {
	now := time.Unix(1755859200, 0)
	signedAt := now.Add(DefaultWindow - time.Second)
	nonces := newFakeNonces()

	rec := httptest.NewRecorder()
	router(fixedConfig(now, nonces)).ServeHTTP(rec, signedRequest(t, "/v1/admin/probe", "", signedAt))
	require.Equal(t, http.StatusOK, rec.Code)

	nonces.mu.Lock()
	defer nonces.mu.Unlock()
	require.Len(t, nonces.seen, 1)
	for _, expiresAt := range nonces.seen {
		assert.True(t, expiresAt.After(now.Add(DefaultWindow)),
			"a row anchored to arrival would expire while the request is still replayable")
	}
}

func TestMiddlewareRequiresAttributionOnReads(t *testing.T) {
	now := time.Unix(1755859200, 0)

	for _, header := range []string{HeaderOperator, HeaderCapability} {
		t.Run(header, func(t *testing.T) {
			// Re-signed WITHOUT the field, so this tests the attribution
			// requirement rather than accidentally testing the signature.
			ts := strconv.FormatInt(now.Unix(), 10)
			in := SignatureInput{
				Method: http.MethodGet, Path: "/v1/admin/probe",
				Timestamp: ts, Nonce: "018f3c2a-0000-7000-8000-000000000abd",
				Operator: "op_7f3a", Capability: "audit.read",
			}
			if header == HeaderOperator {
				in.Operator = ""
			} else {
				in.Capability = ""
			}
			sig, err := Sign(testSecret, in)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodGet, "/v1/admin/probe", nil)
			req.Header.Set(HeaderTimestamp, in.Timestamp)
			req.Header.Set(HeaderNonce, in.Nonce)
			req.Header.Set(HeaderOperator, in.Operator)
			req.Header.Set(HeaderCapability, in.Capability)
			req.Header.Set(HeaderSignature, sig)

			rec := httptest.NewRecorder()
			router(fixedConfig(now, newFakeNonces())).ServeHTTP(rec, req)
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

func TestMiddlewareRejectsMissingHeaders(t *testing.T) {
	now := time.Unix(1755859200, 0)

	for _, header := range []string{HeaderSignature, HeaderTimestamp, HeaderNonce} {
		t.Run(header, func(t *testing.T) {
			req := signedRequest(t, "/v1/admin/probe", "", now)
			req.Header.Del(header)

			rec := httptest.NewRecorder()
			router(fixedConfig(now, newFakeNonces())).ServeHTTP(rec, req)
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

// TestMiddlewareFailsClosedWhenUnconfigured — 503, not a pass-through. An
// unconfigured deploy of a surface carrying every user record must not be
// open, and must not look like a missing route either.
func TestMiddlewareFailsClosedWhenUnconfigured(t *testing.T) {
	now := time.Unix(1755859200, 0)

	for name, cfg := range map[string]Config{
		"no secret": {Nonces: newFakeNonces(), Now: func() time.Time { return now }},
		"no store":  {Secret: testSecret, Now: func() time.Time { return now }},
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router(cfg).ServeHTTP(rec, signedRequest(t, "/v1/admin/probe", "", now))

			assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
			var body map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "not_configured", body["error"])
		})
	}
}

func TestParseTimestampRejectsASignedInteger(t *testing.T) {
	_, err := parseTimestamp("+1755859200")
	assert.Error(t, err, "two byte strings must not denote one instant")

	_, err = parseTimestamp("1755859200")
	assert.NoError(t, err)
}
