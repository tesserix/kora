// Package platformauth verifies requests signed by the Tesserix platform
// console's federation client.
//
// It is NOT package bffauth, and the two must not be merged. bffauth verifies
// the tesserix-home admin PORTAL (apps/web), whose canonical string carries
// userID/email/role/pool and no query, no nonce and no capability. This
// package verifies the platform API's federation client
// (tesserix-home/platform-api/internal/platform/federation), whose scheme is
// mark8ly's — canonical query, single-use nonce, operator and capability. The
// two canonical strings are byte-incompatible: a request signed for one and
// verified by the other is an opaque 401 with no local symptom. Kora serves
// both because it has two callers, not because either is legacy.
//
// The reference implementation is mark8ly's
// services/marketplace-api/internal/handlers/platformadmin/signature.go, and
// the scheme is specified nowhere else — not in a doc, not in the integration
// contract. What keeps the three copies honest is testdata/vectors.json,
// copied byte-for-byte from theirs (all three files hash identically as of
// 2026-08-26). Changing anything in this file without the vectors still
// passing means the console silently 401s against production.
//
// Only Verify is exported for production use. Sign exists because a verifier
// cannot be tested without one, and because the vectors pin both halves.
//
// Four properties are load-bearing, and each fails as a silent 401 rather
// than as an error, which is why they are stated rather than left to be
// inferred:
//
//   - The signed Path is c.Request.URL.Path — already percent-decoded by
//     net/http — never RawPath, never EscapedPath, never the raw wire
//     target. Kora mounts this surface under /v1/admin, so the signed path
//     includes the /v1 prefix; the registered federation BaseURL must
//     therefore end in "/v1" (see docs/admin-contract.md).
//   - Query values are escaped with application/x-www-form-urlencoded
//     semantics — a space becomes "+", a literal "+" becomes "%2B". Go's
//     url.QueryEscape does this natively. The same scheme implemented in
//     TypeScript against encodeURIComponent would emit "%20" and 401 on
//     every query value containing a space.
//   - Method, Path, Timestamp, Nonce, Operator and Capability may not
//     contain '\n' or '\r'. The canonical string joins with "\n" and carries
//     no length prefixes, so Operator="a", Capability="b\nc" would otherwise
//     produce the same bytes as Operator="a\nb", Capability="c". A literal
//     "%0A" in a request path decodes to a real newline in URL.Path, so this
//     is enforced rather than left accidental.
//   - Verify accepts hex in either case. Sign always emits lowercase, but
//     several client stacks emit uppercase by default and a naive string
//     comparison against one would 401 with no explanation.
package platformauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// Header names carried by every signed platform call. These must match
// mark8ly's platformadmin constants and the federation client's exactly.
const (
	HeaderOperator   = "X-Platform-Operator"
	HeaderCapability = "X-Platform-Capability"
	HeaderTimestamp  = "X-Platform-Timestamp"
	HeaderNonce      = "X-Platform-Nonce"
	HeaderSignature  = "X-Platform-Signature"
)

// SignatureInput is everything the HMAC covers. Operator and capability are
// signed so neither can be substituted after signing — they are the
// attribution this whole surface exists to record.
//
// Path must be the decoded URL.Path. See the package doc.
type SignatureInput struct {
	Method     string
	Path       string
	RawQuery   string
	Body       []byte
	Timestamp  string
	Nonce      string
	Operator   string
	Capability string
}

// CanonicalQuery renders a query string deterministically: keys sorted, then
// values within a repeated key sorted, each percent-encoded, joined by "&".
// Both sides must agree byte-for-byte, so nothing here may depend on map
// iteration order.
func CanonicalQuery(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "", fmt.Errorf("platformauth: parse query: %w", err)
	}

	keys := make([]string, 0, len(values))
	total := 0
	for k, vs := range values {
		keys = append(keys, k)
		total += len(vs)
	}
	sort.Strings(keys)

	parts := make([]string, 0, total)
	for _, k := range keys {
		vs := append([]string(nil), values[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(v))
		}
	}
	return strings.Join(parts, "&"), nil
}

// checkNoLineBreaks guards the fields joined by "\n" that are not otherwise
// protected from ambiguity. RawQuery is percent-escaped by CanonicalQuery and
// Body is folded into a fixed-width hash, so neither needs the check. Order
// is fixed so a multi-field violation always names the same field first.
func checkNoLineBreaks(in SignatureInput) error {
	fields := []struct{ name, value string }{
		{"method", in.Method},
		{"path", in.Path},
		{"timestamp", in.Timestamp},
		{"nonce", in.Nonce},
		{"operator", in.Operator},
		{"capability", in.Capability},
	}
	for _, f := range fields {
		if strings.ContainsAny(f.value, "\n\r") {
			return fmt.Errorf("platformauth: %s must not contain a newline or carriage return", f.name)
		}
	}
	return nil
}

// CanonicalString builds the string the HMAC covers: eight fields joined by
// "\n". The body is included as a hash rather than inline so a captured
// signature cannot be lifted onto a different payload. An absent body hashes
// as the empty string.
func CanonicalString(in SignatureInput) (string, error) {
	if err := checkNoLineBreaks(in); err != nil {
		return "", err
	}

	query, err := CanonicalQuery(in.RawQuery)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(in.Body)

	return strings.Join([]string{
		strings.ToUpper(strings.TrimSpace(in.Method)),
		in.Path,
		query,
		hex.EncodeToString(sum[:]),
		in.Timestamp,
		in.Nonce,
		in.Operator,
		in.Capability,
	}, "\n"), nil
}

// Sign returns the lowercase hex HMAC-SHA256 of the canonical string. It
// rejects an empty secret: an unconfigured secret reaching this layer is a
// misconfiguration that should be loud rather than producing a valid-looking
// HMAC over nothing.
func Sign(secret string, in SignatureInput) (string, error) {
	if secret == "" {
		return "", fmt.Errorf("platformauth: secret must not be empty")
	}

	canonical, err := CanonicalString(in)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// Verify compares a presented signature against the expected one in constant
// time, decoding both sides to bytes first so hex case does not matter.
//
// A malformed (non-hex) presented signature is a failed verification, not a
// caller error: on the wire it is indistinguishable from a client with a
// mismatched key. A malformed query or an empty secret still yields an error,
// so a log can separate "bad request" and "misconfigured" from "bad
// signature" while the client still sees one opaque status.
func Verify(secret, got string, in SignatureInput) (bool, error) {
	want, err := Sign(secret, in)
	if err != nil {
		return false, err
	}

	gotRaw, err := hex.DecodeString(got)
	if err != nil {
		return false, nil
	}
	wantRaw, err := hex.DecodeString(want)
	if err != nil {
		return false, err
	}
	return hmac.Equal(gotRaw, wantRaw), nil
}
