package platformauth

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Gin context keys carrying the verified caller.
//
// Named platform_* so they can never be confused with bffauth's admin_* (the
// portal's operator) or auth's user_* (a Firebase end user). Three disjoint
// populations reach this process; collapsing any two of them into one key is
// how an audit row ends up attributed to the wrong human.
const (
	CtxOperatorID = "platform_operator_id"
	CtxCapability = "platform_capability"
)

// DefaultWindow bounds how far a request's timestamp may sit from ours in
// either direction. Five minutes, matching mark8ly — deliberately wider than
// bffauth's 60s, because this caller is another cluster's process rather than
// a browser-adjacent one and its clock is not ours to assume about.
const DefaultWindow = 5 * time.Minute

// maxBodyBytes caps what is buffered to hash BEFORE any credential is
// checked, so an unauthenticated caller cannot make kora-api allocate without
// bound. 1 MiB matches the federation client's own response read limit.
//
// This surface is read-only today (see docs/admin-contract.md and #447), so no
// route behind it sends a body at all. The cap is here anyway because the
// hash covers the body whether or not one is expected, and because the day a
// write lands is not the day to start thinking about it.
const maxBodyBytes = 1 << 20

// maxIdentityLen bounds the signed Operator and Capability fields. Both are
// recorded, so this is a sanity bound against a buggy or compromised gateway
// writing unbounded junk into an integrity record.
const maxIdentityLen = 256

// Config configures Middleware.
type Config struct {
	// Secret is the shared HMAC key. Empty means NOT CONFIGURED and every
	// request is refused 503 — this surface fails closed.
	Secret string
	// Nonces records nonces for replay defence. Required when Secret is set;
	// a nil store refuses every request for the same reason an empty secret
	// does.
	Nonces NonceStore
	// Now is injectable for tests. Defaults to time.Now.
	Now func() time.Time
	// Window overrides the +/- timestamp tolerance. Defaults to DefaultWindow.
	Window time.Duration
	// Logger receives rejection detail. Optional.
	Logger *slog.Logger
}

// Middleware verifies the federation client's signature, enforces the replay
// window and the single-use nonce, and puts the acting operator and the
// capability being exercised on the context.
//
// Operator and capability are required on EVERY request, read or write.
// Contract §8.4: a product "refuses a request that arrives without one"
// rather than deciding for itself what an operator may do. Kora is stricter
// than mark8ly here, which requires them only on writes — the federation
// client refuses to make any call without both, so nothing legitimate is
// turned away, and the alternative is an audit trail with holes in it that
// nobody notices until they are needed.
//
// The VALUE of the capability gates nothing. Kora does not own the privilege
// model: the console asserts what it is exercising, this surface records it
// and refuses its absence. There is no per-route capability matrix here
// because there are no writes to gate — when one lands, mark8ly's
// RequiredWriteCapabilities is the shape to copy, not to reinvent.
func Middleware(cfg Config) gin.HandlerFunc {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	window := cfg.Window
	if window <= 0 {
		window = DefaultWindow
	}

	return func(c *gin.Context) {
		if cfg.Secret == "" || cfg.Nonces == nil {
			httpx.Error(c, http.StatusServiceUnavailable, "not_configured",
				"platform admin surface is not configured")
			return
		}

		body, err := readAndRestoreBody(c)
		if err != nil {
			// 400, not 401: no credential was ever assessed. Answering 401
			// would send an operator hunting a key mismatch that does not
			// exist — the same reasoning bffauth applies.
			httpx.Error(c, http.StatusBadRequest, "invalid_request",
				"request body could not be read")
			return
		}

		in := SignatureInput{
			Method:     c.Request.Method,
			Path:       c.Request.URL.Path,
			RawQuery:   c.Request.URL.RawQuery,
			Body:       body,
			Timestamp:  c.GetHeader(HeaderTimestamp),
			Nonce:      c.GetHeader(HeaderNonce),
			Operator:   c.GetHeader(HeaderOperator),
			Capability: c.GetHeader(HeaderCapability),
		}

		// Signature, timestamp and nonce failures all return one status.
		// Distinguishing them on the wire tells a caller which half of the
		// check they passed; the detail goes to the log instead, because an
		// operator who has already confirmed the keys match needs somewhere
		// left to look.
		presented := c.GetHeader(HeaderSignature)
		if presented == "" || in.Timestamp == "" || in.Nonce == "" {
			reject(c, cfg.Logger, "missing signature headers")
			return
		}
		if len(in.Operator) > maxIdentityLen || len(in.Capability) > maxIdentityLen {
			reject(c, cfg.Logger, "operator or capability exceeds max length")
			return
		}

		// Parsed once: the same instant backs both the window check and the
		// nonce TTL below, so the two can never disagree about when this
		// request stops being valid.
		signedTS, err := parseTimestamp(in.Timestamp)
		if err != nil || !withinWindow(signedTS, now(), window) {
			reject(c, cfg.Logger, "timestamp outside window")
			return
		}

		ok, err := Verify(cfg.Secret, presented, in)
		if err != nil || !ok {
			reject(c, cfg.Logger, "signature mismatch")
			return
		}

		// Attribution is checked AFTER the signature, because both fields are
		// bound into the MAC: refusing an absent operator earlier would let an
		// unauthenticated caller distinguish "wrong key" from "no operator".
		if in.Operator == "" {
			reject(c, cfg.Logger, "operator missing")
			return
		}
		if in.Capability == "" {
			reject(c, cfg.Logger, "capability missing")
			return
		}

		// Claim AFTER everything else, so an unauthenticated caller cannot
		// burn nonces the real console might later use.
		//
		// The TTL is anchored to the SIGNED timestamp, not to arrival. A
		// request stays signature-valid for the whole window around signedTS,
		// including the future-dated edge; anchoring to "now" would let a
		// captured request outlive its own row once the sweep runs, making it
		// replayable again.
		fresh, err := cfg.Nonces.Claim(c.Request.Context(), in.Nonce, signedTS.Add(window))
		if err != nil || !fresh {
			reject(c, cfg.Logger, "nonce replayed or unverifiable")
			return
		}

		c.Set(CtxOperatorID, in.Operator)
		c.Set(CtxCapability, in.Capability)
		c.Next()
	}
}

// parseTimestamp reads the signed timestamp as a strict decimal Unix second
// count. A leading '+' or '-' is rejected rather than silently accepted:
// strconv.ParseInt allows one, which would let "+1755859200" and
// "1755859200" denote the same instant with two different byte strings — a
// wart in a scheme whose entire job is to be unambiguous across three
// independent implementations.
func parseTimestamp(ts string) (time.Time, error) {
	if ts == "" {
		return time.Time{}, errors.New("platformauth: timestamp is empty")
	}
	if ts[0] == '+' || ts[0] == '-' {
		return time.Time{}, errors.New("platformauth: timestamp must be an unsigned decimal integer")
	}
	secs, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		// Deliberately not wrapped: strconv quotes the raw header value back
		// verbatim, which would leak request content into whatever logs this.
		return time.Time{}, errors.New("platformauth: timestamp is not a decimal integer")
	}
	return time.Unix(secs, 0), nil
}

func withinWindow(signedTS, now time.Time, window time.Duration) bool {
	delta := now.Sub(signedTS)
	if delta < 0 {
		delta = -delta
	}
	return delta <= window
}

// readAndRestoreBody buffers the body so it can be hashed, then puts it back
// so a downstream handler could still bind it.
func readAndRestoreBody(c *gin.Context) ([]byte, error) {
	if c.Request.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes))
	if err != nil {
		return nil, err
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}

func reject(c *gin.Context, logger *slog.Logger, reason string) {
	if logger != nil {
		logger.Warn("platformauth: rejected request",
			"reason", reason,
			"path", c.Request.URL.Path,
			"method", c.Request.Method)
	}
	httpx.Error(c, http.StatusUnauthorized, "unauthenticated", "platform authentication failed")
}
