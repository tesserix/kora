package signin

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// A sign-in that passed its first factor and now waits for an authenticator
// code. Kept here rather than handed to the app: the session token is a
// half-finished sign-in, and the app only ever needs an opaque handle to it.
type pendingTOTP struct {
	userID   string
	session  session
	req      completion
	clientID string
	expires  time.Time
	attempts int
}

const (
	totpWindow = 5 * time.Minute
	// Per challenge. A miss after the last one discards the challenge, so a
	// guesser has to pass the password (or provider) again for five more.
	totpAttempts = 5
)

// totpChallenges holds pending second factors in process, like the rate
// limits: one replica makes it exact. A restart loses them, which costs the
// person one more password entry.
type totpChallenges struct {
	mu      sync.Mutex
	pending map[string]*pendingTOTP
}

func newTOTPChallenges() *totpChallenges {
	return &totpChallenges{pending: map[string]*pendingTOTP{}}
}

func (t *totpChallenges) open(p pendingTOTP, now time.Time) (string, error) {
	id, err := randomState()
	if err != nil {
		return "", err
	}
	p.expires = now.Add(totpWindow)
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, v := range t.pending {
		if now.After(v.expires) {
			delete(t.pending, k)
		}
	}
	t.pending[id] = &p
	return id, nil
}

// take reserves the challenge for one attempt. While reserved it is out of
// the map, so two requests racing on one challenge cannot both spend it.
func (t *totpChallenges) take(id string, now time.Time) (*pendingTOTP, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.pending[id]
	delete(t.pending, id)
	if !ok || now.After(p.expires) {
		return nil, false
	}
	return p, true
}

// miss returns a challenge after a wrong code, unless that was its last.
func (t *totpChallenges) miss(id string, p *pendingTOTP) bool {
	p.attempts++
	if p.attempts >= totpAttempts {
		return false
	}
	t.restore(id, p)
	return true
}

// restore returns a challenge whose attempt never reached a verdict.
func (t *totpChallenges) restore(id string, p *pendingTOTP) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pending[id] = p
}

// totpRequired answers a first factor that needs a second. The message is
// for builds without the code screen, which show it as is; this one reads
// the challenge and asks for the code.
func (h *Handler) totpRequired(c *gin.Context, p pendingTOTP) {
	id, err := h.totp.open(p, time.Now())
	if err != nil {
		unavailable(c, "open totp challenge", err)
		return
	}
	c.JSON(http.StatusForbidden, gin.H{
		"error":     "totp_required",
		"message":   "This account uses an authenticator app. Update Kora to sign in with it.",
		"challenge": id,
	})
}

type totpRequest struct {
	Challenge string `json:"challenge"`
	Code      string `json:"code"`
}

func (h *Handler) verifyTOTP(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req totpRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	code := strings.Join(strings.Fields(req.Code), "")
	if req.Challenge == "" || len(code) != 6 || strings.Trim(code, "0123456789") != "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Enter the 6-digit code from your authenticator app.")
		return
	}
	p, ok := h.totp.take(req.Challenge, time.Now())
	if !ok {
		challengeExpired(c)
		return
	}
	ctx := c.Request.Context()
	s, err := h.zitadel.checkTOTP(ctx, p.session, code)
	switch {
	case errors.Is(err, errInvalidCode):
		if h.totp.miss(req.Challenge, p) {
			httpx.Error(c, http.StatusBadRequest, "invalid_code", "That code didn't work. Check your authenticator app and try again.")
		} else {
			challengeExpired(c)
		}
		return
	case err != nil:
		// No verdict on the code, so the attempt is not spent.
		h.totp.restore(req.Challenge, p)
		unavailable(c, "check totp", err)
		return
	}
	h.finish(c, s, p.req, p.clientID)
}

func challengeExpired(c *gin.Context) {
	httpx.Error(c, http.StatusUnauthorized, "challenge_expired", "That sign-in has expired. Please sign in again.")
}
