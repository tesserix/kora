# Kora food-data admin — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the HMAC-signed admin path from the tesserix-home portal to kora-api, and prove it end to end with one read-only surface: a browsable, searchable food index.

**Architecture:** tesserix-home becomes a trusted BFF signer for kora-api, exactly as it already is for homechef-api. It signs `method \n path \n sha256(body) \n ts \n userId \n email \n role \n pool` with a shared HMAC-SHA256 key and calls `kora-api-direct.kora.svc.cluster.local:8080` in-cluster. kora-api gains a `bffauth` middleware that verifies that signature and an `/v1/admin` route group gated by it. The portal gains no database access to Kora — that is the point of the design.

**Tech Stack:** Go 1.26 + Gin + GORM (kora-api) · Next.js 16 + React 19 + TypeScript (tesserix-home) · Helm + ArgoCD (tesserix-k8s) · GCP Secret Manager + External Secrets Operator.

**Spec:** `docs/superpowers/specs/2026-08-05-kora-food-data-admin-design.md` (slice 1 row of the Implementation slices table).

---

## Global Constraints

- **Mirror the HomeChef scheme; do not invent one.** The canonical string is
  `${method}\n${path}\n${sha256hex(body)}\n${ts}\n${userId}\n${email}\n${role}\n${pool}`,
  `"\n"`-separated, taken verbatim from `Home-Chef-App/apps/api/middleware/bff_auth.go:351-358`
  and `tesserix-home/apps/web/lib/api/homechef-admin.ts:55-69`. Any drift is a 401.
- **The key is base64 in the environment, raw bytes in the MAC**, minimum 16 decoded
  bytes — matching `Home-Chef-App/apps/api/config/config.go:424-433`. Both sides decode
  before use. A key that is used base64-encoded on one side and decoded on the other
  produces a valid-looking signature that never verifies.
- **`path` excludes the query string.** It is Go's `r.URL.Path`.
- **Slice 1 is read-only.** No `kora_admin_events`, no `food_embedding_jobs`, no mutation
  endpoints, no CSV upload, no `deleted_at`. Those are slices 2–4. Do not drift.
- Single-line conventional commit messages. No body, no trailers, no signature.
- Branch before committing. Never commit to `main` in any of the three repos.
- Tests run in the FOREGROUND. Never background a test command.
- Go tests: `cd api && go test -race -p 1 -count=1 ./...` from the repo root's `api/`.
- Portal tests: `pnpm --filter web test:unit` **from the tesserix-home repo root** — it is a
  pnpm workspace with `node-linker=hoisted`, so `apps/web/node_modules` is nearly empty by
  design and running from `apps/web` fails with a misleading MODULE_NOT_FOUND.
- Portal tests are **co-located** (`X.test.ts` beside the source). There are no `__tests__/`
  directories and vitest will not discover one.
- `beforeEach(() => mock.mockReset())` is **broken** in this vitest version — `mockReset()`
  returns the mock and vitest treats a returned value as a teardown callback. Always use a
  block body: `beforeEach(() => { mock.mockReset(); })`.

## House rules for every task

- **Mutation-verify every test you write.** Break the behaviour the test names, confirm the
  test fails **on its own assertion** (read the failure message — a false red becomes a false
  green the moment you fix the wrong thing), revert, confirm `git diff` is clean.
- **Confirm the mutation actually applied.** BSD `sed` silently matches nothing for the
  `0,/re/s//` form. A mutation that "doesn't fail" may never have been made. Check the file
  changed before concluding a test is inadequate.
- **A one-sided assertion is a vacuous guard.** Every "must reject" needs its "must accept"
  twin, and vice versa.
- **Ambient database state is a vacuity source.** The shared `kora-pg-test` database holds
  85 `food_items` rows with **zero** embedded. Never derive a test's expectation from
  whatever that database happens to contain. Seed controlled rows inside a `db.Begin()`
  transaction, register the rollback with `t.Cleanup` immediately, and assert the baseline
  is *discriminating* before trusting it.
- **The LSP emits stale false diagnostics** about undefined Go symbols in this repo. It has
  fired at least four times across sessions, false every time. Trust the compiler
  (`go build ./...`, `go vet ./...`), not the LSP.
- Namespace all briefs and reports under `.superpowers/sdd/food-data-slice-1/`.

## File Structure

**kora** (branch `feat/kora-admin-bff`)

| File | Responsibility |
|---|---|
| `api/internal/bffauth/bffauth.go` | Canonical-string construction + Gin middleware. Nothing else. |
| `api/internal/bffauth/bffauth_test.go` | Signature/identity/freshness tests + the fixed drift vector. |
| `api/internal/admin/repository.go` | Paginated food listing with an optional search filter. |
| `api/internal/admin/repository_test.go` | Against a real Postgres in a rolled-back transaction. |
| `api/internal/admin/handler.go` | Query-param parsing, validation, response shape. |
| `api/internal/admin/handler_test.go` | Handler behaviour against a fake lister. |
| `api/internal/config/config.go` | *Modify* — decode `KORA_BFF_HMAC_KEY`. |
| `api/internal/config/config_test.go` | *Modify* — key decoding and its failure modes. |
| `api/internal/server/router.go` | *Modify* — mount `/v1/admin` behind `bffauth.Middleware`. |
| `api/internal/server/router_test.go` | *Modify* — end-to-end signed request reaches the handler. |

`bffauth` and `admin` are separate packages deliberately: the middleware is reused verbatim
by every later slice and by three other planned admin surfaces, while `admin` grows
mutation handlers in slice 2. Splitting them now avoids a later untangle.

**tesserix-k8s** (branch `feat/kora-portal-reachability`)

| File | Responsibility |
|---|---|
| `charts/thirdparty/istio-config/templates/network-policies.yaml` | *Modify* — allow ns `tesserix` into ns `kora`. |
| `charts/thirdparty/istio-config/templates/authorization-policies.yaml` | *Modify* — same, at L4, for intent. |
| `charts/apps/kora-api/values.yaml` | *Modify* — add the HMAC key to `externalSecret.remoteRefs`. |
| `charts/apps/company/templates/externalsecret.yaml` | *Modify* — same GSM secret, portal side. |
| `charts/apps/company/values-prod.yaml` | *Modify* — `KORA_API_URL`. |

**tesserix-home** (branch `feat/kora-foods-admin`)

| File | Responsibility |
|---|---|
| `apps/web/lib/api/kora-admin.ts` | Signing + fetch. The only place that knows the wire format. |
| `apps/web/lib/api/kora-admin.test.ts` | Fixed drift vector + header/query construction. |
| `apps/web/app/admin/apps/kora/foods/page.tsx` | Thin server component: read params, call, render. |
| `apps/web/components/admin/sidebar.tsx` | *Modify* — one `koraNav` entry. |
| `apps/web/lib/products/configs.test.ts` | *Modify* — nav assertion. |

Pages stay thin on purpose: all Kora-specific logic lives behind `lib/api/kora-admin.ts`, so
relocating the UI to a Next.js multi-zone in the kora repo later is a page move, not a
rewrite.

---

## Task 1: `bffauth` HMAC middleware

**Files:**
- Create: `api/internal/bffauth/bffauth.go`
- Test: `api/internal/bffauth/bffauth_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `bffauth.Identity{UserID, Email, Role, Pool string}`
  - `bffauth.Compute(method, path string, body []byte, ts string, key []byte, id Identity) string`
  - `bffauth.Middleware(key []byte, window time.Duration) gin.HandlerFunc`
  - Context keys `bffauth.CtxAdminID = "admin_id"` and `bffauth.CtxAdminEmail = "admin_email"`

**Two deliberate divergences from the HomeChef original, both narrowing:**

1. **No Bearer fallback.** HomeChef's `BFFAuthConfig.BFFSessionURL` exists for mobile clients
   that hold a session token. Kora has no auth-bff and the portal is the only signer, so the
   fallback would be dead code and a second trust path. Omitted.
2. **No user-row hydration.** HomeChef's `BFFAuth` does a DB lookup and materialises admin
   rows. Kora's admin caller is a *platform* admin with no Kora user row and must never get
   one — Kora's `users` table is end users only. The middleware sets the identity on the
   context and stops.

It **adds** two authorization guards that HomeChef performs elsewhere: the caller's role must
be `admin` and the user id must be non-empty. These are not scheme changes (the wire format is
byte-identical) — they pin "the portal is the only signer" in code rather than in a comment,
which matters because slice 2 attributes audit rows to this identity.

- [ ] **Step 1: Write the failing tests**

Create `api/internal/bffauth/bffauth_test.go`:

```go
package bffauth

import (
	"encoding/base64"
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

// A CORRECTLY SIGNED non-admin is 403, not 401 — the signature verified, the
// authorization did not. Distinct codes keep the two failures distinguishable
// in production, where 401 means "key or clock problem" and 403 means "this
// caller is not an admin".
func TestMiddlewareRejectsCorrectlySignedNonAdmin(t *testing.T) {
	key := testKey(t)
	id := adminIdentity()
	id.Role = "customer"
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && go test ./internal/bffauth/... -run . -v 2>&1 | head -20`

Expected: build failure — `undefined: Compute`, `undefined: Identity`, `undefined: Middleware`.
(If the LSP claims these are undefined *after* Step 3, ignore it and trust this command.)

- [ ] **Step 3: Write the implementation**

Create `api/internal/bffauth/bffauth.go`:

```go
// Package bffauth verifies HMAC-signed requests from a trusted backend-for-
// frontend. The tesserix-home admin portal is the only signer: it holds the
// same key kora-api does and signs each admin call as itself, so kora-api
// learns WHICH platform admin is acting without the portal ever touching
// Kora's database.
//
// The wire format is copied from HomeChef's equivalent
// (Home-Chef-App/apps/api/middleware/bff_auth.go) and MUST stay byte-identical
// to tesserix-home's lib/api/kora-admin.ts. Drift manifests as a blanket 401
// on every admin request, so both sides pin the same fixed vector in tests.
package bffauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Header names. Must stay in lockstep with tesserix-home's buildSignedHeaders.
const (
	HdrUserID    = "X-User-Id"
	HdrUserEmail = "X-User-Email"
	HdrUserRole  = "X-User-Role"
	HdrAuthPool  = "X-Auth-Pool"
	HdrAuthTs    = "X-Auth-Ts"
	HdrSignature = "X-Internal-Auth"
)

// Gin context keys carrying the verified caller. Named admin_* rather than
// user_* so they can never be confused with the end-user identity that
// auth.Middleware sets from a Firebase token — these are disjoint populations
// and a platform admin has no Kora user row.
const (
	CtxAdminID    = "admin_id"
	CtxAdminEmail = "admin_email"
)

// RoleAdmin and PoolInternal are the only identity the portal signs as.
const (
	RoleAdmin    = "admin"
	PoolInternal = "internal"
)

// DefaultWindow is how far a request's timestamp may be from now, in either
// direction. Matches HomeChef's 60s.
const DefaultWindow = 60 * time.Second

var (
	errMissingSignature  = errors.New("missing signature")
	errSignatureMismatch = errors.New("signature mismatch")
	errStaleTimestamp    = errors.New("stale timestamp")
	errBodyRead          = errors.New("body read failed")
)

// Identity is the caller the signature attests to. Every field is bound into
// the MAC, so a captured request cannot be replayed with a different role or
// pool asserted in its headers.
type Identity struct {
	UserID string
	Email  string
	Role   string
	Pool   string
}

// Compute builds the HMAC over the canonical message.
//
// CRITICAL: this string MUST stay byte-identical to computeSignature() in
// tesserix-home/apps/web/lib/api/kora-admin.ts — same field order, same "\n"
// separators, same lowercase-hex body digest. TestComputePinsTheCanonicalString
// and its TypeScript counterpart pin both to one fixed vector.
func Compute(method, path string, body []byte, ts string, key []byte, id Identity) string {
	bodyHash := sha256.Sum256(body)
	m := hmac.New(sha256.New, key)
	fmt.Fprintf(m, "%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s",
		method, path, hex.EncodeToString(bodyHash[:]), ts,
		id.UserID, id.Email, id.Role, id.Pool)
	return hex.EncodeToString(m.Sum(nil))
}

// Middleware verifies the signature and, on success, puts the caller's id and
// email on the Gin context. A window of 0 means DefaultWindow.
func Middleware(key []byte, window time.Duration) gin.HandlerFunc {
	if window <= 0 {
		window = DefaultWindow
	}
	return func(c *gin.Context) {
		id, err := verify(c, key, window)
		if err != nil {
			if errors.Is(err, errBodyRead) {
				// 400, not 401: the credentials were never assessed. Answering
				// 401 here would send an operator hunting a key mismatch that
				// does not exist.
				httpx.Error(c, http.StatusBadRequest, "invalid_input", "could not read request body")
				return
			}
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing signature")
			return
		}

		// Authorization, distinct from authentication. The signature proved the
		// caller holds the key; these guards pin WHO the key may act as. 403
		// keeps "not an admin" distinguishable from "bad key or skewed clock"
		// in production logs.
		if id.Role != RoleAdmin || id.UserID == "" {
			httpx.Error(c, http.StatusForbidden, "forbidden", "admin identity required")
			return
		}

		c.Set(CtxAdminID, id.UserID)
		c.Set(CtxAdminEmail, id.Email)
		c.Next()
	}
}

func verify(c *gin.Context, key []byte, window time.Duration) (Identity, error) {
	sig := c.GetHeader(HdrSignature)
	if sig == "" {
		return Identity{}, errMissingSignature
	}

	// Read the body so it can be re-hashed, then restore it for the handler.
	var body []byte
	if c.Request.Body != nil {
		b, err := io.ReadAll(c.Request.Body)
		if err != nil {
			return Identity{}, fmt.Errorf("%w: %v", errBodyRead, err)
		}
		body = b
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
	}

	ts := c.GetHeader(HdrAuthTs)
	tsInt, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return Identity{}, fmt.Errorf("bad timestamp: %w", err)
	}

	id := Identity{
		UserID: c.GetHeader(HdrUserID),
		Email:  c.GetHeader(HdrUserEmail),
		Role:   c.GetHeader(HdrUserRole),
		Pool:   c.GetHeader(HdrAuthPool),
	}

	// Signature FIRST, in constant time, so the freshness check cannot become a
	// timing oracle on an unverified request.
	want := Compute(c.Request.Method, c.Request.URL.Path, body, ts, key, id)
	if !hmac.Equal([]byte(sig), []byte(want)) {
		return Identity{}, errSignatureMismatch
	}

	if d := time.Since(time.Unix(tsInt, 0)); d > window || d < -window {
		return Identity{}, errStaleTimestamp
	}
	return id, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && go test -race -count=1 ./internal/bffauth/...`
Expected: `ok  github.com/tesserix/kora/api/internal/bffauth`

- [ ] **Step 5: Mutation-verify the three load-bearing properties**

Do these one at a time, confirming the file actually changed each time, and revert after each.

**Mutation A — identity binding.** In `Compute`, drop the identity fields from the
format string and its arguments, leaving `"%s\n%s\n%s\n%s"` over method/path/bodyhash/ts.
Expected: `TestComputePinsTheCanonicalString`, `TestMiddlewareRejectsSwappedRoleHeader` and
`TestMiddlewareRejectsSwappedPoolHeader` all FAIL. Confirm the swapped-header tests fail on
their own `assert.Equal(401, ...)`, not on a panic.

**Mutation B — body binding.** In `verify`, pass `nil` instead of `body` to `Compute`.
Expected: `TestMiddlewareRejectsTamperedBody` FAILS. Confirm
`TestMiddlewareAcceptsAValidSignatureAndExposesTheIdentity` still PASSES (it signs an empty
body, so it cannot discriminate here — that is what the tampered-body test is for).

**Mutation C — the role guard.** Delete `id.Role != RoleAdmin ||` from the guard.
Expected: `TestMiddlewareRejectsCorrectlySignedNonAdmin` FAILS with 200 where 403 was wanted.

After each: `git diff` must be clean before continuing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git checkout -b feat/kora-admin-bff
git add api/internal/bffauth/
git commit -m "feat(api): hmac bff auth middleware for the admin path"
```

---

## Task 2: admin food listing — repository and handler

**Files:**
- Create: `api/internal/admin/repository.go`
- Create: `api/internal/admin/handler.go`
- Test: `api/internal/admin/repository_test.go`
- Test: `api/internal/admin/handler_test.go`

**Interfaces:**
- Consumes: `nutrition.FoodItem` (from `api/internal/nutrition/model.go`) — do not redefine it.
- Produces:
  - `admin.ListParams{Query string; Limit, Offset int}`
  - `admin.ListResult{Items []nutrition.FoodItem; Total int64}`
  - `admin.FoodLister` interface — `ListFoods(ctx context.Context, p ListParams) (ListResult, error)`
  - `admin.NewRepository(db *gorm.DB) Repository` implementing `FoodLister`
  - `admin.NewHandler(l FoodLister) Handler` with method `ListFoods(c *gin.Context)`

**Why not reuse `nutrition.Repository.Search`:** it caps at `searchLimitMax = 25`, has no
offset, and returns no total — it exists to feed a mobile picker, not to page an index of
7,898 rows. Widening it would change mobile behaviour. A separate admin-owned query keeps the
two consumers independent, which is the same reason `admin` is its own package.

- [ ] **Step 1: Write the failing repository test**

This test seeds inside a transaction and rolls back, because the shared `kora-pg-test`
database holds 85 pre-existing rows that would otherwise decide the outcome.

Create `api/internal/admin/repository_test.go`:

```go
package admin

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

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

// seedTx opens a transaction, registers its rollback immediately (so it runs on
// Goexit too, e.g. a require failure), and inserts controlled rows. Every
// assertion below is made against THIS transaction, so the 85 ambient rows in
// the shared test database can never satisfy or defeat one.
func seedTx(t *testing.T, db *gorm.DB, items ...nutrition.FoodItem) *gorm.DB {
	t.Helper()
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	for i := range items {
		require.NoError(t, tx.Create(&items[i]).Error)
	}
	return tx
}

func food(name, brand string) nutrition.FoodItem {
	return nutrition.FoodItem{
		Name:           name,
		Brand:          brand,
		NormalizedName: name,
		Provenance:     nutrition.ProvenanceCurated,
		ServingDesc:    "1 serve",
		ServingGrams:   100,
		KcalPer100g:    100,
	}
}

func TestListFoodsFiltersByQueryAcrossNameAndBrand(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db,
		food("zzz-admin-oats", "Uncle Tobys"),
		food("zzz-admin-quinoa", "Zzz Oatsbrand"),
		food("zzz-admin-lentils", "Nothing"),
	)
	repo := NewRepository(tx)

	got, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-admin-", Limit: 10})
	require.NoError(t, err)
	require.Len(t, got.Items, 3, "the three seeded rows must all match the shared prefix")

	// The discriminating assertion: "oats" must match the NAME of one row and
	// the BRAND of another, and must NOT match the third. If it matched all
	// three or none, this test would prove nothing about the filter.
	got, err = repo.ListFoods(context.Background(), ListParams{Query: "oats", Limit: 10})
	require.NoError(t, err)
	names := map[string]bool{}
	for _, it := range got.Items {
		names[it.Name] = true
	}
	assert.True(t, names["zzz-admin-oats"], "must match on name")
	assert.True(t, names["zzz-admin-quinoa"], "must match on brand")
	assert.False(t, names["zzz-admin-lentils"], "must not match an unrelated row")
}

func TestListFoodsPagesWithStableOrderAndReportsTotal(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db,
		food("zzz-page-a", ""),
		food("zzz-page-b", ""),
		food("zzz-page-c", ""),
	)
	repo := NewRepository(tx)

	first, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-page-", Limit: 2, Offset: 0})
	require.NoError(t, err)
	second, err := repo.ListFoods(context.Background(), ListParams{Query: "zzz-page-", Limit: 2, Offset: 2})
	require.NoError(t, err)

	require.Len(t, first.Items, 2)
	require.Len(t, second.Items, 1)
	assert.Equal(t, []string{"zzz-page-a", "zzz-page-b"}, []string{first.Items[0].Name, first.Items[1].Name})
	assert.Equal(t, "zzz-page-c", second.Items[0].Name)

	// Total is the count of MATCHES, not of the returned page — the pager needs
	// to know there are 3 while holding 2.
	assert.Equal(t, int64(3), first.Total)
	assert.Equal(t, int64(3), second.Total)
	assert.NotEqual(t, int64(len(first.Items)), first.Total,
		"if Total equalled the page size this test could not tell the two apart")
}

func TestListFoodsWithNoQueryReturnsEverythingItCanSee(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db, food("zzz-all-one", ""), food("zzz-all-two", ""))
	repo := NewRepository(tx)

	// Baseline must be discriminating: inside this transaction the unfiltered
	// total has to exceed the two rows we seeded, or "no filter" and "filter
	// matched everything" would be indistinguishable.
	got, err := repo.ListFoods(context.Background(), ListParams{Limit: 5})
	require.NoError(t, err)
	require.Greater(t, got.Total, int64(2), "shared table must hold more than the seeded rows for this to discriminate")
	assert.LessOrEqual(t, len(got.Items), 5, "limit must bound the page")
}
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable \
  go test ./internal/admin/... -run TestListFoods -v 2>&1 | head -20
```
Expected: build failure — `undefined: NewRepository`, `undefined: ListParams`.

If the test SKIPS, the `kora-pg-test` container is not running. Start it and migrate it
before continuing — do not proceed against a skipped test, and do not point
`TEST_DATABASE_URL` at anything other than the local throwaway container.

- [ ] **Step 3: Write the repository**

Create `api/internal/admin/repository.go`:

```go
// Package admin serves the platform admin surfaces behind the signed BFF path.
// Its callers are tesserix-home operators, never end users, so nothing here
// scopes by Kora user id — authorization is bffauth's job, upstream.
package admin

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// DefaultLimit and MaxLimit bound a page. MaxLimit is generous compared with
// nutrition.searchLimitMax (25) because this pages an index of ~7,900 rows for
// a human with a table, not a mobile picker.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

type ListParams struct {
	Query  string
	Limit  int
	Offset int
}

type ListResult struct {
	Items []nutrition.FoodItem `json:"items"`
	Total int64                `json:"total"`
}

// FoodLister is the read surface the handler depends on, so handler tests need
// no database.
type FoodLister interface {
	ListFoods(ctx context.Context, p ListParams) (ListResult, error)
}

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// ListFoods returns one page of the food index plus the total number of rows
// matching the filter. Total counts MATCHES, not the page, so the caller can
// render "showing 50 of 7,898".
func (r Repository) ListFoods(ctx context.Context, p ListParams) (ListResult, error) {
	if p.Limit <= 0 || p.Limit > MaxLimit {
		p.Limit = DefaultLimit
	}
	if p.Offset < 0 {
		p.Offset = 0
	}

	q := r.db.WithContext(ctx).Model(&nutrition.FoodItem{})
	if p.Query != "" {
		pattern := "%" + p.Query + "%"
		q = q.Where("name ILIKE ? OR brand ILIKE ?", pattern, pattern)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return ListResult{}, fmt.Errorf("admin: count foods: %w", err)
	}

	var items []nutrition.FoodItem
	// Order by (name, id): name alone is not unique in this table, and an
	// unstable sort makes paging drop or repeat rows between pages.
	if err := q.Order("name ASC, id ASC").Limit(p.Limit).Offset(p.Offset).
		Find(&items).Error; err != nil {
		return ListResult{}, fmt.Errorf("admin: list foods: %w", err)
	}
	return ListResult{Items: items, Total: total}, nil
}
```

- [ ] **Step 4: Run the repository test to verify it passes**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable \
  go test -race -count=1 ./internal/admin/...
```
Expected: PASS.

- [ ] **Step 5: Write the failing handler test**

Create `api/internal/admin/handler_test.go`:

```go
package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type fakeLister struct {
	got    ListParams
	result ListResult
	err    error
}

func (f *fakeLister) ListFoods(_ context.Context, p ListParams) (ListResult, error) {
	f.got = p
	return f.result, f.err
}

func handlerRouter(l FoodLister) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/foods", NewHandler(l).ListFoods)
	return r
}

func TestListFoodsHandlerPassesQueryAndPagingThrough(t *testing.T) {
	l := &fakeLister{result: ListResult{Items: []nutrition.FoodItem{{Name: "oats"}}, Total: 1}}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?q=oats&limit=10&offset=20", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, ListParams{Query: "oats", Limit: 10, Offset: 20}, l.got)

	var body struct {
		Data ListResult `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, int64(1), body.Data.Total)
	require.Len(t, body.Data.Items, 1)
	assert.Equal(t, "oats", body.Data.Items[0].Name)
}

// The twin for the test above: absent params must NOT silently become the
// values of a previous request or a hardcoded default that differs from the
// repository's. Zero means "unset" and the repository applies its own default.
func TestListFoodsHandlerDefaultsMissingParamsToZero(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, ListParams{Query: "", Limit: 0, Offset: 0}, l.got)
}

func TestListFoodsHandlerRejectsNonNumericLimit(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?limit=abc", nil))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, ListParams{}, l.got, "a rejected request must never reach the repository")
}

func TestListFoodsHandlerRejectsNegativeOffset(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?offset=-5", nil))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, ListParams{}, l.got)
}

// An infrastructure failure must be a 500, never an empty 200. An empty list
// renders as "no foods found", which reads as a fact about the index rather
// than a fault — the same class of silent failure this project keeps hitting.
func TestListFoodsHandlerReportsRepositoryFailureAs500(t *testing.T) {
	l := &fakeLister{err: errors.New("connection refused")}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), "connection refused", "internal detail must not reach the client")
}

// The twin: an EMPTY index is a legitimate 200 with an empty list, not a 500.
func TestListFoodsHandlerReturns200ForAnEmptyIndex(t *testing.T) {
	l := &fakeLister{result: ListResult{Items: []nutrition.FoodItem{}, Total: 0}}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	require.Equal(t, http.StatusOK, w.Code)
	// items must serialise as [] and never null — the page maps over it.
	assert.Contains(t, w.Body.String(), `"items":[]`)
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd api && go test ./internal/admin/... -run TestListFoodsHandler -v 2>&1 | head -20`
Expected: build failure — `undefined: NewHandler`.

- [ ] **Step 7: Write the handler**

Create `api/internal/admin/handler.go`:

```go
package admin

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	foods FoodLister
}

func NewHandler(foods FoodLister) Handler { return Handler{foods: foods} }

// ListFoods serves GET /v1/admin/foods?q=&limit=&offset=.
//
// Unset limit/offset are passed through as zero rather than defaulted here, so
// there is exactly ONE place that decides what a page is (the repository). Two
// defaulting sites drift.
func (h Handler) ListFoods(c *gin.Context) {
	limit, err := intParam(c, "limit")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "limit must be a non-negative integer")
		return
	}
	offset, err := intParam(c, "offset")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "offset must be a non-negative integer")
		return
	}

	result, err := h.foods.ListFoods(c.Request.Context(), ListParams{
		Query:  c.Query("q"),
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	// Never let a nil slice serialise as null: the portal page maps over it.
	if result.Items == nil {
		result.Items = []nutrition.FoodItem{}
	}
	httpx.OK(c, result)
}

func intParam(c *gin.Context, name string) (int, error) {
	raw := c.Query(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, strconv.ErrRange
	}
	return v, nil
}
```

Note: this file needs `"github.com/tesserix/kora/api/internal/nutrition"` in its imports for
the nil-slice guard. Add it.

- [ ] **Step 8: Run the whole package**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable \
  go test -race -count=1 ./internal/admin/...
```
Expected: PASS, all tests, none skipped.

- [ ] **Step 9: Mutation-verify**

**Mutation A — the filter.** In `ListFoods`, change the `Where` to `name ILIKE ?` only
(drop the brand clause and its argument).
Expected: `TestListFoodsFiltersByQueryAcrossNameAndBrand` FAILS on `must match on brand`.

**Mutation B — total vs page.** Change `Count(&total)` to count the page instead:
set `total = int64(len(items))` after the `Find` and delete the `Count` call.
Expected: `TestListFoodsPagesWithStableOrderAndReportsTotal` FAILS on the `int64(3)` assertion.

**Mutation C — order stability.** Change `Order("name ASC, id ASC")` to `Order("id ASC")`.
Expected: `TestListFoodsPagesWithStableOrderAndReportsTotal` FAILS on the name-sequence
assertion. If it passes, the seeded rows happened to be inserted in name order — reseed with
names out of alphabetical order so the test discriminates, and note it in your report.

**Mutation D — error suppression.** In the handler, replace the `err != nil` branch with
`result = ListResult{}` and fall through to `httpx.OK`.
Expected: `TestListFoodsHandlerReportsRepositoryFailureAs500` FAILS.

Revert each; `git diff` clean between mutations.

- [ ] **Step 10: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/admin/
git commit -m "feat(api): paginated admin food index listing"
```

---

## Task 3: config, router wiring, and the end-to-end signed request

**Files:**
- Modify: `api/internal/config/config.go`
- Modify: `api/internal/config/config_test.go`
- Modify: `api/internal/server/router.go`
- Modify: `api/internal/server/router_test.go`

**Interfaces:**
- Consumes: `bffauth.Middleware`, `bffauth.Compute`, `bffauth.Identity` (Task 1);
  `admin.NewRepository`, `admin.NewHandler` (Task 2).
- Produces: `config.Config.BFFHMACKey []byte`; the mounted route `GET /v1/admin/foods`.

**The config contract, and why it is asymmetric:**

- `KORA_BFF_HMAC_KEY` **unset** → `BFFHMACKey` is nil → admin routes are **not mounted**.
  This mirrors how the resolve engine degrades when `GEMINI_API_KEY` is absent, and it keeps
  local development and CI working with no new required secret.
- `KORA_BFF_HMAC_KEY` **set but invalid** (bad base64, or under 16 decoded bytes) →
  `config.Load` returns an **error** and the process exits.

The asymmetry is deliberate. "Unset" is a legitimate deployment (dev, CI, any environment
with no portal). "Set but wrong" is always a mistake, and silently disabling the admin surface
for it would present as an unexplained 404 in production — the exact failure shape this
project has hit repeatedly. Fail loudly instead.

- [ ] **Step 1: Write the failing config tests**

Append to `api/internal/config/config_test.go` (match the file's existing style for setting
env vars — read it first and follow whatever helper it already uses):

```go
func TestLoadDecodesBFFHMACKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("KORA_BFF_HMAC_KEY", "a29yYS10ZXN0LWhtYWMta2V5LTEyMzQ1Ng==")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, []byte("kora-test-hmac-key-123456"), cfg.BFFHMACKey,
		"the env var is base64; the MAC needs the decoded bytes")
}

func TestLoadLeavesBFFHMACKeyNilWhenUnset(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("KORA_BFF_HMAC_KEY", "")

	cfg, err := Load()
	require.NoError(t, err, "an absent key is a valid deployment, not an error")
	assert.Nil(t, cfg.BFFHMACKey)
}

func TestLoadRejectsMalformedBFFHMACKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("KORA_BFF_HMAC_KEY", "not!valid!base64!")

	_, err := Load()
	require.Error(t, err, "a set-but-unusable key must fail loudly, not disable admin silently")
	assert.Contains(t, err.Error(), "KORA_BFF_HMAC_KEY")
}

func TestLoadRejectsShortBFFHMACKey(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	// "short" -> 5 decoded bytes, under the 16-byte floor.
	t.Setenv("KORA_BFF_HMAC_KEY", "c2hvcnQ=")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "16")
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && go test ./internal/config/... -run BFFHMAC -v 2>&1 | head -20`
Expected: build failure — `cfg.BFFHMACKey undefined`.

- [ ] **Step 3: Implement the config change**

In `api/internal/config/config.go`, add to the `Config` struct after `ExpoAccessToken`:

```go
	// BFFHMACKey is the shared secret the tesserix-home admin portal signs its
	// requests to /v1/admin/* with. Nil when KORA_BFF_HMAC_KEY is unset, which
	// leaves the admin routes unmounted — a valid deployment (dev, CI, any
	// environment with no portal). A key that is SET but unusable is a hard
	// error instead: silently disabling admin would surface as an unexplained
	// 404 rather than a startup failure.
	//
	// The env var is base64 (matching HomeChef's BFF_INTERNAL_HMAC_KEY); the
	// MAC is computed over the DECODED bytes. Using the encoded form on either
	// side produces signatures that never verify.
	BFFHMACKey []byte
```

Add `"encoding/base64"` to the imports, and after the `MetricsPort` check in `Load`:

```go
	if raw := os.Getenv("KORA_BFF_HMAC_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return Config{}, fmt.Errorf("config: KORA_BFF_HMAC_KEY must be valid base64: %w", err)
		}
		if len(key) < 16 {
			return Config{}, fmt.Errorf("config: KORA_BFF_HMAC_KEY must decode to at least 16 bytes, got %d", len(key))
		}
		cfg.BFFHMACKey = key
	}
```

- [ ] **Step 4: Run the config tests**

Run: `cd api && go test -race -count=1 ./internal/config/...`
Expected: PASS.

- [ ] **Step 5: Write the failing router test**

Append to `api/internal/server/router_test.go`:

```go
// The end-to-end proof of the signed path: a request signed exactly the way
// tesserix-home signs it must reach the admin handler through the real router.
// Every other test in this plan exercises one side; this one joins them.
func TestAdminFoodsIsReachableWithAValidSignature(t *testing.T) {
	key := []byte("kora-test-hmac-key-123456")
	r := NewRouter(Deps{DB: testDB(t), Verifier: fakeVerifier{}, BFFHMACKey: key})

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
	r := NewRouter(Deps{DB: testDB(t), Verifier: fakeVerifier{}, BFFHMACKey: []byte("kora-test-hmac-key-123456")})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// A Firebase bearer token — an END USER's credential — must not open the admin
// surface. The two auth systems are disjoint and this pins that.
func TestAdminFoodsRejectsAFirebaseBearerToken(t *testing.T) {
	r := NewRouter(Deps{DB: testDB(t), Verifier: fakeVerifier{}, BFFHMACKey: []byte("kora-test-hmac-key-123456")})

	req := httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil)
	req.Header.Set("Authorization", "Bearer any-valid-user-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// With no key configured the routes must not exist at all — 404, not 401.
// A 401 would mean the surface is mounted and merely unauthenticated.
func TestAdminFoodsIsUnmountedWithoutAKey(t *testing.T) {
	r := NewRouter(Deps{DB: testDB(t), Verifier: fakeVerifier{}})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}
```

**Read `router_test.go` first.** It already has helpers for building a router and a fake
verifier — use whatever names exist there rather than the placeholder `testDB`/`fakeVerifier`
above, and adapt these tests to that file's conventions. If the existing tests build a router
with `DB: nil`, note that `/v1/admin/foods` needs a non-nil DB to be mounted, and follow
whatever pattern the file already uses to get one.

- [ ] **Step 6: Run to verify it fails**

Run: `cd api && go test ./internal/server/... -run TestAdminFoods -v 2>&1 | head -30`
Expected: `Deps.BFFHMACKey undefined`, then once that compiles, 404s where 200 was wanted.

- [ ] **Step 7: Wire the router**

In `api/internal/server/router.go`, add to `Deps`:

```go
	// BFFHMACKey is the shared secret the tesserix-home admin portal signs
	// /v1/admin/* requests with. When nil the admin routes are not mounted at
	// all, so an unconfigured environment answers 404 rather than 401 — the
	// difference matters when diagnosing a deployment.
	BFFHMACKey []byte
```

Add the import `"github.com/tesserix/kora/api/internal/admin"` and
`"github.com/tesserix/kora/api/internal/bffauth"`.

Inside the `if deps.DB != nil && deps.Verifier != nil {` block, after the existing
`v1.GET("/foods", nutritionHandler.Search)` line, add:

```go
			// Admin surface. A SEPARATE group from v1: /v1 carries
			// auth.Middleware (Firebase end-user tokens) and these callers are
			// platform admins with no Firebase identity and no Kora user row.
			// Gin's radix tree keeps /v1/foods and /v1/admin/foods distinct, so
			// the two groups never collide.
			if len(deps.BFFHMACKey) > 0 {
				adminHandler := admin.NewHandler(admin.NewRepository(deps.DB))
				adminGroup := r.Group("/v1/admin", bffauth.Middleware(deps.BFFHMACKey, 0))
				adminGroup.GET("/foods", adminHandler.ListFoods)
			}
```

In `api/cmd/api/main.go`, extend the `server.Deps` literal on the `srv := &http.Server{` line:

```go
		Handler: server.NewRouter(server.Deps{DB: db, Verifier: verifier, Resolver: resolveHandler, Provider: aiProvider, ResolveCache: resolveCache, BFFHMACKey: cfg.BFFHMACKey}),
```

And after the food-index refresher block, log which state the admin surface is in — a silent
absence is what this whole plan is built to avoid:

```go
	if len(cfg.BFFHMACKey) > 0 {
		logger.Info("admin surface enabled", "routes", "/v1/admin/*")
	} else {
		logger.Info("admin surface disabled (no KORA_BFF_HMAC_KEY)")
	}
```

- [ ] **Step 8: Run the full Go suite**

Run:
```bash
cd api && go vet ./... && \
  TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable \
  go test -race -p 1 -count=1 ./...
```
Expected: vet clean; every package `ok`, zero `FAIL`. Record the package count in your report.

- [ ] **Step 9: Mutation-verify the wiring**

**Mutation A — the middleware is attached.** Change the group to
`r.Group("/v1/admin")` (no middleware).
Expected: `TestAdminFoodsRejectsAnUnsignedRequest` FAILS with 200 where 401 was wanted.

**Mutation B — the mount guard.** Change `if len(deps.BFFHMACKey) > 0` to `if true`.
Expected: `TestAdminFoodsIsUnmountedWithoutAKey` FAILS with 401 where 404 was wanted.

**Mutation C — the path/query boundary.** In `bffauth.verify`, change
`c.Request.URL.Path` to `c.Request.URL.RequestURI()` (which includes `?limit=1`).
Expected: `TestAdminFoodsIsReachableWithAValidSignature` FAILS with 401. This is the exact
drift that would break the portal client, so confirm it discriminates.

- [ ] **Step 10: Commit and open the PR**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/config/ api/internal/server/ api/cmd/api/main.go
git commit -m "feat(api): mount the signed admin route group"
git push -u origin feat/kora-admin-bff
gh pr create --title "feat(api): hmac-signed admin path and food index listing (slice 1)" --body "$(cat <<'EOF'
Slice 1 of the food-data admin design: the signed BFF path plus one read-only surface.

- `internal/bffauth` — HMAC-SHA256 middleware mirroring HomeChef's wire format byte for byte, pinned by a fixed vector that tesserix-home's client test pins to the same constant.
- `internal/admin` — paginated, searchable food index listing with a real total.
- `GET /v1/admin/foods`, mounted only when `KORA_BFF_HMAC_KEY` is set.

No mutations, no audit table, no embedding job — those are slices 2-4.
EOF
)"
```

Do **not** merge. Report the PR number and CI status.

---

## Task 4: cluster reachability and the shared secret

**Files (all in `tesserix-k8s`):**
- Modify: `charts/thirdparty/istio-config/templates/network-policies.yaml`
- Modify: `charts/thirdparty/istio-config/templates/authorization-policies.yaml`
- Modify: `charts/apps/kora-api/values.yaml`
- Modify: `charts/apps/company/templates/externalsecret.yaml`
- Modify: `charts/apps/company/values-prod.yaml`

**Established by live testing, not assumed:** a shell in the running `company` pod
(ns `tesserix`) cannot reach `kora-api-direct.kora.svc.cluster.local:8080` — the request
**times out**, which is a packet drop, not a refusal or a 403. `kora/allow-kora-ingress`
permits ingress only from `istio-ingress`, `kora`, `global`, `monitoring`, `istio-system`,
`cnpg-system` and kube-dns. `tesserix` is absent. **The NetworkPolicy is the blocker.**

The Istio L4 edit is intent-documentation, not a fix: `allow-mesh-internal-kora` is an ALLOW
policy with `rules: [{}]`, which already matches every source. Adding `tesserix` to
`allow-internal-kora` records the intent so the reachability does not quietly depend on that
catch-all. **Do not report the authz edit as the thing that fixed it.**

- [ ] **Step 1: USER-RUN — create the shared secret**

The permission classifier denies `gcloud` from this session. Ask Mahesh to run these with a
leading `!`, and wait for confirmation before continuing:

```bash
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create prod-kora-bff-internal-hmac-key \
  --replication-policy=automatic --data-file=-
gcloud secrets versions list prod-kora-bff-internal-hmac-key
```

The value must be base64 with **no trailing newline** — a newline changes the decoded bytes on
one side only if the two sides trim differently, and produces a 401 that looks like drift.
`openssl rand -base64 32` yields 32 decoded bytes, over the 16-byte floor.

- [ ] **Step 2: Branch and open the NetworkPolicy**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
git checkout -b feat/kora-portal-reachability
```

In `charts/thirdparty/istio-config/templates/network-policies.yaml`, inside the
`allow-kora-ingress` ingress list (it currently ends with the cnpg-system and kube-system
blocks), add before the kube-system DNS block:

```yaml
    # Allow from the tesserix namespace — the tesserix-home admin portal signs
    # requests to kora-api's /v1/admin/* as a trusted BFF (kora
    # internal/bffauth). Without this the portal's fetch TIMES OUT rather than
    # failing fast, because default-deny-ingress drops the packet before Istio
    # sees it. Mirrors the homechef arrangement.
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ .Values.appNamespaces.tesserix }}
```

Confirm `appNamespaces.tesserix` exists in the chart's values before using it:

```bash
grep -n "tesserix" charts/thirdparty/istio-config/values.yaml
```

If it is absent, use the literal `tesserix` and say so in your report — do not invent a values
key that nothing sets.

- [ ] **Step 3: Open the AuthorizationPolicy**

In `charts/thirdparty/istio-config/templates/authorization-policies.yaml`, in
`allow-internal-kora`, add a fourth `from` block:

```yaml
    # tesserix-home admin portal -> kora-api /v1/admin/*. Recorded explicitly
    # rather than relying on allow-mesh-internal-kora's catch-all `- {}` rule,
    # so tightening that policy later does not silently break the admin surface.
    - from:
        - source:
            namespaces:
              - {{ .Values.appNamespaces.tesserix }}
```

- [ ] **Step 4: Add the secret to both ExternalSecrets**

In `charts/apps/kora-api/values.yaml`, under `externalSecret.remoteRefs`, add:

```yaml
  KORA_BFF_HMAC_KEY: prod-kora-bff-internal-hmac-key
```

Read the surrounding entries first and match their exact indentation and quoting style.

In `charts/apps/company/templates/externalsecret.yaml`, before the closing `{{- end }}`, add:

```yaml
    # Kora admin gateway — tesserix-home signs requests to kora-api's
    # /v1/admin/* as a trusted BFF (lib/api/kora-admin.ts). This MUST be the
    # SAME HMAC key kora-api reads as KORA_BFF_HMAC_KEY, from the same GSM
    # secret, or the API returns 401. Mounted via envFrom on the company
    # deployment.
    - secretKey: KORA_BFF_HMAC_KEY
      remoteRef:
        key: prod-kora-bff-internal-hmac-key
```

In `charts/apps/company/values-prod.yaml`, under `env:`, beside `HOMECHEF_API_URL`:

```yaml
  # kora-api's ClusterIP Service (charts/apps/kora-api service.nameOverride).
  # In-cluster and therefore NOT through the Istio gateway, so no Firebase JWT
  # is involved — the HMAC signature is the whole credential.
  KORA_API_URL: "http://kora-api-direct.kora.svc.cluster.local:8080"
```

- [ ] **Step 5: Validate the charts before pushing**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
helm template istio-config charts/thirdparty/istio-config | grep -A30 "name: allow-kora-ingress" | grep -c tesserix
helm template istio-config charts/thirdparty/istio-config | \
  kubectl apply --dry-run=server -f - 2>&1 | grep -i kora
helm template kora-api charts/apps/kora-api | grep -A3 KORA_BFF_HMAC_KEY
helm template company charts/apps/company --values charts/apps/company/values-prod.yaml | grep -E "KORA_API_URL|KORA_BFF_HMAC_KEY"
```

Expected: the first prints `1` or more (a `0` means the block rendered but did not land in the
right policy — read the output rather than trusting the grep); the dry-run reports the kora
resources as `(server dry run)` with no error; both key names appear.

- [ ] **Step 6: Commit and push**

```bash
git add charts/
git commit -m "feat(kora): let the tesserix admin portal reach kora-api over the signed bff path"
git push -u origin feat/kora-portal-reachability
```

Open a PR. **tesserix-k8s CI is billing-blocked** (it is the remaining private repo) so its
checks will not run — that is expected and does not gate ArgoCD. Say so in the PR body rather
than leaving a reviewer wondering.

- [ ] **Step 7: After merge, verify reachability empirically**

Do not trust ArgoCD's Synced status — this project has three recorded instances of a resource
reporting healthy while doing nothing. Prove it with traffic:

```bash
POD=$(kubectl get pod -n tesserix -l app.kubernetes.io/name=company -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n tesserix "$POD" -- sh -c 'wget -q -T 6 -O- http://kora-api-direct.kora.svc.cluster.local:8080/health'
```

Expected: `{"status":"ok"}`. A timeout means the NetworkPolicy did not take effect. Then
confirm the admin route is mounted and gated:

```bash
kubectl exec -n tesserix "$POD" -- sh -c 'wget -S -q -T 6 -O- http://kora-api-direct.kora.svc.cluster.local:8080/v1/admin/foods 2>&1 | head -5'
```

Expected: **401**. A **404** means kora-api is running an image without Task 3's code, or
`KORA_BFF_HMAC_KEY` did not reach the pod — check the running image digest and pod age, never
the rollout message.

---

## Task 5: the portal's signed client

**Files:**
- Create: `apps/web/lib/api/kora-admin.ts`
- Test: `apps/web/lib/api/kora-admin.test.ts`

**Interfaces:**
- Consumes: kora's `GET /v1/admin/foods` (Task 3); `getCurrentSession` from
  `@/lib/auth/session-jwt`; `logger` from `@/lib/logger`.
- Produces:
  - `computeSignature(method, path, body: Buffer, ts: string, key: Buffer, id: SignedIdentity): string`
  - `buildSignedHeaders(method, path, body, actor, keyBase64, now): Record<string,string>`
  - `koraAdmin<T>(method, adminPath, opts?): Promise<AdminResponse<T>>`
  - `listKoraFoods(params): Promise<KoraFoodPage>` with
    `KoraFoodPage = { items: KoraFood[]; total: number }`

This mirrors `lib/api/homechef-admin.ts` closely. Read that file first and follow its shape,
including its error class and its `cache: "no-store"`. The one structural difference:
**`ADMIN_PREFIX` is `/v1/admin`, not `/api/v1/admin`** — kora-api mounts its routes under
`/v1`, HomeChef under `/api/v1`. Getting this wrong is a 404 that looks like a routing bug.

**Two literals kora's middleware now enforces as a hard 403, so they are not free choices:**
`X-User-Role` must be exactly `admin` and `X-Auth-Pool` must be exactly `internal`. Note that
this org's *GIP tenant pools* are named `platform`, `mp-internal` and `mp-customer` — none of
which is `internal`. Signing with a GIP pool name would 403 every admin request with
"admin identity required" and no signature problem anywhere to find. These are BFF identity
values, not GIP pool names; `internal` is the literal, matching HomeChef.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/api/kora-admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSignedHeaders, computeSignature } from "./kora-admin";

// Decodes to "kora-test-hmac-key-123456". The SAME constant and the SAME
// expected digest are pinned in kora's api/internal/bffauth/bffauth_test.go.
// This pair is the cross-repo drift guard: if either side changes the canonical
// string, one of the two tests goes red instead of every admin request 401ing
// silently in production.
const KEY_B64 = "a29yYS10ZXN0LWhtYWMta2V5LTEyMzQ1Ng==";
const EXPECTED = "592716969fc5d8c9c0b8013ca2027ae3318d02dd31a59868749a7d2dc2aa3ac7";

// Second vector, with a NON-ASCII body. Kora is a food index, so accented
// names are ordinary. Node's createHash().update(string) defaults to UTF-8 but
// silently accepts 'latin1', and the two digests are completely unrelated —
// latin-1 would give 4a2998d2265e54286e1f76af69455861d80411a2f4cff7f3ca2954102b3117d4.
// Without this vector the client signs ASCII foods correctly and 401s on the
// first `crème brûlée`. The Go side pins the identical constant in
// api/internal/bffauth/bffauth_test.go.
const BODY = '{"name":"crème brûlée","kcal":257}';
const EXPECTED_WITH_BODY = "c0328fe10ebf9e64f71f51d007abd65eb0b902bdefab3279033c1cb1d4019ac3";

describe("computeSignature", () => {
  it("matches the Go implementation's fixed vector", () => {
    const sig = computeSignature(
      "GET",
      "/v1/admin/foods",
      Buffer.alloc(0),
      "1735689600",
      Buffer.from(KEY_B64, "base64"),
      {
        userId: "admin-uid-1",
        email: "admin@tesserix.app",
        role: "admin",
        pool: "internal",
      },
    );
    expect(sig).toBe(EXPECTED);
  });

  it("changes when any bound field changes", () => {
    const base = {
      userId: "admin-uid-1",
      email: "admin@tesserix.app",
      role: "admin",
      pool: "internal",
    };
    const key = Buffer.from(KEY_B64, "base64");
    const sign = (id: typeof base) =>
      computeSignature("GET", "/v1/admin/foods", Buffer.alloc(0), "1735689600", key, id);

    // The twin of the fixed-vector test: without this, a computeSignature that
    // ignored identity entirely would still pass the test above as long as the
    // constant happened to match.
    expect(sign({ ...base, role: "customer" })).not.toBe(EXPECTED);
    expect(sign({ ...base, pool: "customer" })).not.toBe(EXPECTED);
    expect(sign({ ...base, userId: "someone-else" })).not.toBe(EXPECTED);
    expect(sign({ ...base, email: "other@tesserix.app" })).not.toBe(EXPECTED);
  });

  it("matches the Go implementation on a UTF-8 body", () => {
    const sig = computeSignature(
      "POST",
      "/v1/admin/foods",
      Buffer.from(BODY, "utf8"),
      "1735689600",
      Buffer.from(KEY_B64, "base64"),
      {
        userId: "admin-uid-1",
        email: "admin@tesserix.app",
        role: "admin",
        pool: "internal",
      },
    );
    expect(sig).toBe(EXPECTED_WITH_BODY);
  });

  it("binds the body", () => {
    const key = Buffer.from(KEY_B64, "base64");
    const a = computeSignature("POST", "/v1/admin/foods", Buffer.from('{"n":1}'), "1735689600", key, {
      userId: "u", email: "e", role: "admin", pool: "internal",
    });
    const b = computeSignature("POST", "/v1/admin/foods", Buffer.from('{"n":2}'), "1735689600", key, {
      userId: "u", email: "e", role: "admin", pool: "internal",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildSignedHeaders", () => {
  it("pins role and pool and sends seconds, not milliseconds", () => {
    const headers = buildSignedHeaders(
      "GET",
      "/v1/admin/foods",
      Buffer.alloc(0),
      { userId: "admin-uid-1", email: "admin@tesserix.app" },
      KEY_B64,
      1735689600123,
    );

    expect(headers["X-User-Role"]).toBe("admin");
    expect(headers["X-Auth-Pool"]).toBe("internal");
    // Go reads this with strconv.ParseInt and compares against Unix seconds. A
    // millisecond value parses fine and then lands ~55,000 years in the future,
    // which the freshness window rejects as an unexplained 401.
    expect(headers["X-Auth-Ts"]).toBe("1735689600");
    expect(headers["X-Internal-Auth"]).toBe(EXPECTED);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run from the **tesserix-home repo root**:
```bash
pnpm --filter web test:unit -- kora-admin
```
Expected: FAIL — cannot resolve `./kora-admin`.

- [ ] **Step 3: Write the client**

Create `apps/web/lib/api/kora-admin.ts`:

```ts
// Server-side signed client for kora-api's /v1/admin/* endpoints.
//
// tesserix-home is a trusted BFF signer for kora-api, exactly as it already is
// for homechef-api (lib/api/homechef-admin.ts). It signs each request itself
// and calls kora-api directly in-cluster, so every admin read flows through
// kora's own API — the portal has NO database access to Kora, which is the
// central decision of the food-data admin design.
//
// Wire format (must match kora api/internal/bffauth/bffauth.go:Compute exactly
// — drift = 401). Identity is BOUND INTO the MAC so kora cannot be handed a
// swapped X-User-Role with a still-valid signature:
//   X-Internal-Auth = HMAC_SHA256(
//     "${method}\n${path}\n${sha256hex(body)}\n${ts}\n${userId}\n${email}\n${role}\n${pool}", key )
//   + X-User-Id, X-User-Email, X-User-Role, X-Auth-Pool, X-Auth-Ts
// where `path` is kora's r.URL.Path (query string EXCLUDED) and `key` is the
// base64-decoded shared secret (kora reads the same GCP secret as
// KORA_BFF_HMAC_KEY).
import crypto from "node:crypto";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const API_URL = process.env.KORA_API_URL ?? "";
const HMAC_KEY_B64 = process.env.KORA_BFF_HMAC_KEY ?? "";

/**
 * Every Kora admin endpoint lives under this prefix. NOTE: kora-api mounts its
 * routes under /v1, NOT /api/v1 like HomeChef. A mismatch here is a 404 that
 * reads like a routing bug.
 */
export const ADMIN_PREFIX = "/v1/admin";

export class KoraAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "KoraAdminError";
  }
}

/** Identity fields bound into the signature (must match Go's `bffauth.Identity`). */
export interface SignedIdentity {
  userId: string;
  email: string;
  role: string;
  pool: string;
}

/**
 * Mirrors `Compute()` in kora's api/internal/bffauth/bffauth.go exactly. Pure
 * and exported so the unit test can pin it to a fixed vector that the Go test
 * pins to the same constant.
 */
export function computeSignature(
  method: string,
  path: string,
  body: Buffer,
  ts: string,
  key: Buffer,
  id: SignedIdentity,
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const mac = crypto.createHmac("sha256", key);
  mac.update(
    `${method}\n${path}\n${bodyHash}\n${ts}\n${id.userId}\n${id.email}\n${id.role}\n${id.pool}`,
  );
  return mac.digest("hex");
}

export interface AdminActor {
  userId: string;
  email: string;
}

/**
 * Builds the full signed header set. The acting admin's id/email are carried so
 * kora can attribute the action (slice 2 writes them to kora_admin_events);
 * role/pool are pinned to admin/internal, and kora's middleware rejects
 * anything else with a 403. Pure (takes `now` and the key) so it is testable.
 */
export function buildSignedHeaders(
  method: string,
  path: string,
  body: Buffer,
  actor: AdminActor,
  keyBase64: string,
  now: number,
): Record<string, string> {
  const key = Buffer.from(keyBase64, "base64");
  // Seconds. Go parses this with strconv.ParseInt and compares against Unix
  // seconds; milliseconds would land far outside the freshness window.
  const ts = Math.floor(now / 1000).toString();
  const id: SignedIdentity = {
    userId: actor.userId,
    email: actor.email,
    role: "admin",
    pool: "internal",
  };
  return {
    "Content-Type": "application/json",
    "X-User-Id": id.userId,
    "X-User-Email": id.email,
    "X-User-Role": id.role,
    "X-Auth-Pool": id.pool,
    "X-Auth-Ts": ts,
    "X-Internal-Auth": computeSignature(method, path, body, ts, key, id),
  };
}

export type AdminMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: unknown;
  search?: URLSearchParams | Record<string, string>;
}

export interface AdminResponse<T> {
  status: number;
  data: T;
}

function toQuery(search: RequestOptions["search"]): string {
  if (!search) return "";
  const qs =
    search instanceof URLSearchParams
      ? search.toString()
      : new URLSearchParams(
          Object.fromEntries(Object.entries(search).filter(([, v]) => v !== "")),
        ).toString();
  return qs ? `?${qs}` : "";
}

/**
 * Call a Kora admin endpoint, signed as a trusted BFF.
 * @param adminPath path UNDER /v1/admin, e.g. "/foods".
 */
export async function koraAdmin<T = unknown>(
  method: AdminMethod,
  adminPath: string,
  opts: RequestOptions = {},
): Promise<AdminResponse<T>> {
  if (!API_URL || !HMAC_KEY_B64) {
    throw new KoraAdminError(
      500,
      "not_configured",
      "KORA_API_URL / KORA_BFF_HMAC_KEY are not set",
    );
  }
  const session = await getCurrentSession();
  if (!session) throw new KoraAdminError(401, "no_session");

  const path = `${ADMIN_PREFIX}${adminPath.startsWith("/") ? adminPath : `/${adminPath}`}`;
  const bodyBytes =
    opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0);
  // Signed over `path` only — the query string is deliberately excluded, to
  // match Go's r.URL.Path.
  const headers = buildSignedHeaders(
    method,
    path,
    bodyBytes,
    { userId: session.sub, email: session.email },
    HMAC_KEY_B64,
    Date.now(),
  );
  const url = `${API_URL}${path}${toQuery(opts.search)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyBytes.length ? bodyBytes : undefined,
      cache: "no-store",
    });
  } catch (err) {
    logger.error("[kora-admin] upstream unreachable", err);
    throw new KoraAdminError(502, "upstream_unreachable");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    logger.warn(`[kora-admin] ${method} ${path} -> ${res.status}`);
  }
  return { status: res.status, data: data as T };
}

/** One food row as kora's nutrition.FoodItem serialises it. */
export interface KoraFood {
  id: string;
  name: string;
  brand: string;
  provenance: string;
  barcode?: string;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  created_at: string;
}

export interface KoraFoodPage {
  items: KoraFood[];
  total: number;
}

export async function listKoraFoods(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<KoraFoodPage> {
  const res = await koraAdmin<{ data: KoraFoodPage }>("GET", "/foods", {
    search: {
      q: params.q ?? "",
      limit: params.limit ? String(params.limit) : "",
      offset: params.offset ? String(params.offset) : "",
    },
  });
  if (res.status !== 200) {
    throw new KoraAdminError(res.status, "list_foods_failed");
  }
  // kora wraps every response in {"data": ...} (internal/httpx.OK).
  return res.data.data;
}
```

- [ ] **Step 4: Run the tests**

Run from the repo root: `pnpm --filter web test:unit -- kora-admin`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run from the repo root: `pnpm --filter web typecheck`
Expected: the SAME error count as `origin/main`. There is one known pre-existing error in
`components/admin/payment-gateway` territory — establish the baseline by typechecking
`origin/main` directly rather than assuming any error is pre-existing.

- [ ] **Step 6: Mutation-verify**

**Mutation A — the canonical string.** In `computeSignature`, reorder `${id.role}` and
`${id.pool}`.
Expected: the fixed-vector test FAILS. This is the property that keeps the two repos in sync.

**Mutation B — seconds vs milliseconds.** Change `Math.floor(now / 1000)` to `now`.
Expected: the `X-Auth-Ts` assertion FAILS.

**Mutation C — the prefix.** Change `ADMIN_PREFIX` to `/api/v1/admin`.
Expected: the fixed-vector test still PASSES (it passes the path explicitly), and nothing
fails. **This is a real coverage gap** — note it in your report and add an assertion to the
`buildSignedHeaders` test that pins the prefix, or state plainly that only Task 6's live
verification can catch it.

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git checkout -b feat/kora-foods-admin
git add apps/web/lib/api/kora-admin.ts apps/web/lib/api/kora-admin.test.ts
git commit -m "feat(admin): signed client for kora-api's admin endpoints"
```

---

## Task 6: the food index page and its nav entry

**Files:**
- Create: `apps/web/app/admin/apps/kora/foods/page.tsx`
- Modify: `apps/web/components/admin/sidebar.tsx`
- Modify: `apps/web/lib/products/configs.test.ts`

**Interfaces:**
- Consumes: `listKoraFoods`, `KoraFood`, `KoraAdminError` (Task 5).
- Produces: the route `/admin/apps/kora/foods`.

**A live correctness note for the sidebar:** the last session's reviewer recorded that
`isNavItemActive` needs no mark8ly-style prefix guard "YET — but that becomes wrong the moment
Phase 2 adds a nested route under /admin/apps/kora". **This task is that moment.** Read
`isNavItemActive` and `getActiveContext` before editing, and check whether the Overview entry
(`/admin/apps/kora`) will now also render active when the user is on `/admin/apps/kora/foods`.
If it does, fix it the way mark8ly's entries already handle it, and add an assertion. Do not
skip this because the nav "looks fine" — a permanently-active Overview link is exactly the
kind of thing nobody reports.

- [ ] **Step 1: Read the conventions before writing anything**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/apps/web
sed -n '230,290p' components/admin/sidebar.tsx
ls app/admin/apps/homechef/users/
```

Follow whatever table/empty-state/error components those pages already use. Do not introduce
a new table primitive — use what the portal has.

- [ ] **Step 2: Write the page**

Create `apps/web/app/admin/apps/kora/foods/page.tsx`. It is a server component: it reads
`searchParams`, calls `listKoraFoods`, and renders. Requirements, each of which must be
visible in the rendered output:

- A search input that drives `?q=` via a GET form (URL-driven, so the page stays a server
  component and the search is shareable and back-button-correct).
- Columns: name, brand, provenance, kcal/100g, protein, carbs, fat, fiber, serving.
- Paging via `?offset=`, with the **total** rendered — "showing 1–50 of 7,898". The total is
  the reason the API returns one; do not drop it.
- An explicit **error state**. If `listKoraFoods` throws, render a message saying the food
  index could not be loaded and include the status. It must be visually distinct from the
  empty state. An error that renders as "no foods found" is a wrong answer presented as a
  fact, which is the failure mode this whole project keeps re-learning.
- An **empty state** for a search that genuinely matched nothing.

- [ ] **Step 3: Add the nav entry**

In `components/admin/sidebar.tsx`, add to `koraNav` after the Overview entry:

```tsx
  { name: "Food index", href: "/admin/apps/kora/foods", icon: Database },
```

Import `Database` from `lucide-react` if it is not already imported. Check the existing import
line rather than adding a duplicate.

- [ ] **Step 4: Extend the nav test**

In `apps/web/lib/products/configs.test.ts` (or wherever the existing nav assertion lives —
find it, do not create a parallel one), assert that `koraNav` contains the foods entry and
that its href is exactly `/admin/apps/kora/foods`.

If you found an active-state bug in Step 1's reading, add a test for it here too, asserting
that `isNavItemActive("/admin/apps/kora", "/admin/apps/kora/foods")` is **false** while
`isNavItemActive("/admin/apps/kora/foods", "/admin/apps/kora/foods")` is **true**. Both
halves — the false one alone would pass against a function that always returns false.

- [ ] **Step 5: Run the full portal suite**

Run from the repo root:
```bash
pnpm --filter web test:unit
pnpm --filter web lint
pnpm --filter web typecheck
```
Expected: all tests pass (report the count against the pre-change count), lint clean,
typecheck at the `origin/main` baseline.

- [ ] **Step 6: Mutation-verify the page's error handling**

Temporarily make `listKoraFoods` throw unconditionally and load the page in `next dev`.
Expected: the error state renders, NOT an empty table. Revert and confirm a clean `git diff`.

If the page cannot be loaded locally (it needs `KORA_API_URL` and a session), say so plainly
in your report rather than claiming a verification you did not perform.

- [ ] **Step 7: Commit and open the PR**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add apps/web/app/admin/apps/kora/foods/ apps/web/components/admin/sidebar.tsx apps/web/lib/products/
git commit -m "feat(admin): kora food index browse page"
git push -u origin feat/kora-foods-admin
gh pr create --title "feat(admin): kora food index browse over the signed BFF path" --body "Slice 1 of the Kora food-data admin design. Adds the signed client for kora-api's /v1/admin/* endpoints and a read-only food index page. Depends on kora's slice-1 PR and tesserix-k8s reachability being deployed first."
```

Do not merge.

---

## Final verification, after all three PRs are merged and deployed

Order matters: **tesserix-k8s first** (secret + reachability), **then kora** (the API must be
serving `/v1/admin/foods` before the portal links to it), **then tesserix-home**.

- [ ] kora-api's running pod carries a digest built from the slice-1 merge commit — check the
      **pod age and image digest**, never `kubectl rollout status`, which has reported
      "successfully rolled out" here while a 16-hour-old pod was still the only one running.
- [ ] `kubectl -n kora logs deploy/kora-api | grep "admin surface"` prints
      `admin surface enabled`. If it prints `disabled`, the ExternalSecret did not deliver the
      key — check the mounted env, not the ExternalSecret's Synced status.
- [ ] From the company pod: `/v1/admin/foods` unsigned returns **401** (not 404, not a timeout).
- [ ] The portal renders `/admin/apps/kora/foods` with a non-zero total that **matches the
      database**. Cross-check with a direct read-only query against `kora_db` on
      `global-postgres` — `SELECT count(*) FROM food_items`. At the time of writing that is
      7,898. Two numbers agreeing is the evidence; the page rendering is not.
- [ ] Search for a term you can verify by hand and confirm both the result set and the total
      change. A total that never moves means the filter is not reaching the count query.

---

## Self-review notes

**Spec coverage.** Slice 1's row is "`bff_auth`, `KORA_BFF_HMAC_KEY`, `GET /v1/admin/foods`
(list + search), `kora-admin.ts`, the food index page". Task 1 covers `bff_auth`; Task 4
covers `KORA_BFF_HMAC_KEY` (both ExternalSecrets and the GSM secret); Tasks 2–3 cover the
endpoint and its mounting; Task 5 covers `kora-admin.ts`; Task 6 covers the page and nav.
The spec's "nav entries in `components/admin/sidebar.tsx`" is Task 6 Step 3.

**Deliberately out of slice 1**, per the spec's slice table: `kora_admin_events`,
`food_embedding_jobs`, create/update/soft-delete, cache eviction, re-embed-on-rename, CSV
upload, the embedding and audit pages.

**Not in the spec but required, discovered during recon:** Task 4's NetworkPolicy change. The
spec assumed the portal could reach kora-api; it cannot, and the failure mode is a timeout
rather than an error, which would have read as a hung page rather than a missing rule.
