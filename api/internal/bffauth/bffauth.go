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
