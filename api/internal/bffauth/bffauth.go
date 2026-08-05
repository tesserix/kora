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
	"log/slog"
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

// maxAdminBodyBytes caps the raw request body read BEFORE the signature is
// verified, mirroring maxPhotoBodyBytes's role in package resolve and
// maxAskBodyBytes's role in package coach. Without a cap, an unauthenticated
// caller could make kora-api buffer an arbitrary body with no credential at
// all. This cap is GLOBAL: every route mounted behind Middleware inherits
// it, not just the read-only listing Slice 1 ships. The design spec's Slice
// 4 is a bulk CSV upload of "tens to low hundreds of rows" — roughly 100
// foods of JSON is already ~20 KB, over this cap — so that endpoint will
// need either its own larger limit or a streaming/chunked upload path; it
// cannot reuse this middleware's body read unmodified. Do not raise this
// constant to accommodate it without re-checking every other route behind
// this middleware, since they would all inherit the increase too.
const maxAdminBodyBytes = 16 << 10 // 16 KiB

var (
	errSignatureMismatch = errors.New("signature mismatch")
	errStaleTimestamp    = errors.New("stale timestamp")
	errBodyRead          = errors.New("body read failed")
	// errBadTimestamp covers both an absent X-Auth-Ts header and one that
	// fails to parse as an integer — strconv.ParseInt treats "" the same as
	// any other malformed input, so these two causes are indistinguishable
	// upstream of this point and share one sentinel.
	errBadTimestamp = errors.New("bad or missing timestamp")
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

			// The wire response stays the deliberately vague "invalid or
			// missing signature" for every cause below — that contract is
			// pinned cross-repo and must not change. But a wrong key, a
			// malformed/missing timestamp, and a clock skew are three
			// different operator actions, and without a server-side trace an
			// operator who has already confirmed the keys match has nowhere
			// left to look. Log which sentinel fired so `kubectl logs` can
			// recover the cause; log nothing else about the request — no
			// header values, no signature, no timestamp — beyond that.
			reason := "unknown"
			switch {
			case errors.Is(err, errSignatureMismatch):
				reason = "signature_mismatch"
			case errors.Is(err, errStaleTimestamp):
				reason = "stale_timestamp"
			case errors.Is(err, errBadTimestamp):
				reason = "bad_timestamp"
			}
			slog.WarnContext(c.Request.Context(), "bffauth: rejected request", "reason", reason)

			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing signature")
			return
		}

		// Authorization, distinct from authentication. The signature proved the
		// caller holds the key; these guards pin WHO the key may act as. 403
		// keeps "not an admin" distinguishable from "bad key or skewed clock"
		// in production logs. Pool is bound into the MAC (see Compute), so
		// checking it here is belt-and-suspenders, not the only thing standing
		// between an unrelated pool and an admin route — but it must actually be
		// checked, or the PoolInternal constant is a lie.
		//
		// id.Email == "" is guarded here alongside UserID for the same reason:
		// Email is bound into the MAC (see Compute), so a correctly-signed
		// request can still carry X-User-Email: "". kora_admin_events.actor_email
		// has a CHECK rejecting an empty/whitespace value, but that insert
		// happens INSIDE the mutation's transaction — without this guard, a
		// missing-attribution request would abort the whole mutation with a 500
		// instead of failing cleanly here with a 403.
		if id.Role != RoleAdmin || id.UserID == "" || id.Email == "" || id.Pool != PoolInternal {
			httpx.Error(c, http.StatusForbidden, "forbidden", "admin identity required")
			return
		}

		c.Set(CtxAdminID, id.UserID)
		c.Set(CtxAdminEmail, id.Email)
		c.Next()
	}
}

func verify(c *gin.Context, key []byte, window time.Duration) (Identity, error) {
	// No dedicated empty-signature guard: an absent signature never matches
	// Compute's output, so hmac.Equal below rejects it regardless.
	sig := c.GetHeader(HdrSignature)

	// Read the body so it can be re-hashed, then restore it for the handler.
	// Bounded by maxAdminBodyBytes BEFORE the signature is checked, so an
	// unauthenticated caller cannot make kora-api buffer an arbitrary body.
	var body []byte
	if c.Request.Body != nil {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAdminBodyBytes)
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
		// Deliberately does not wrap the strconv error: its message quotes
		// the raw header value back verbatim, which would leak request
		// content into whatever eventually logs this sentinel.
		return Identity{}, errBadTimestamp
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
