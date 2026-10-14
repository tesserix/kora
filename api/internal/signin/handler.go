// Package signin backs Kora's own sign-in, sign-up and password-reset screens.
// The app never shows Zitadel's hosted login: it posts credentials here,
// kora-api checks them through Zitadel's Session API, and the app receives an
// OIDC authorization code it redeems itself with its own PKCE verifier. So
// kora-api sees passwords in transit but never holds a user's tokens, and the
// tokens the app ends up with are the same Zitadel access and refresh tokens
// the hosted login would have produced.
//
// Every route here is public by necessity: the caller has no token yet. Each
// one answers the same way whether or not an account exists, except where
// saying so is the point (sign-up's email_taken), and each is rate limited per
// email address.
package signin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/ratelimit"
)

// RedirectURI is the redirect URI registered on kora-ios and kora-android.
// Zitadel puts the authorization code on it; the app redeems the code with the
// same value. Must byte-match the claims: single slash after the scheme.
const RedirectURI = "com.tesserix.kora:/auth/callback"

// IDPCallbackURL is where Zitadel sends the browser after Google or Apple.
// The app's auth session closes on it and hands the intent id and token back
// here. A constant, never a request field: Zitadel does not validate an
// intent's success URL, so a caller-chosen one would hand a finished sign-in
// to whatever the caller named.
const IDPCallbackURL = "com.tesserix.kora:/auth/idp"

// IdentityDeleter removes a Zitadel user. Sign-up uses it to clear an account
// whose email was never verified, which has no proven owner and would
// otherwise hold the address against the person now proving they own it.
type IdentityDeleter interface {
	DeleteIdentity(ctx context.Context, subject string) error
}

type Config struct {
	Issuer    string
	ProjectID string
	// Token is the kora-login-client PAT. Empty leaves every route answering
	// 503 rather than unmounted, so the app can tell "not yet" from "gone".
	Token string
	// ClientIDs maps "ios" and "android" to the native OIDC client ids.
	ClientIDs map[string]string
	// IDPs maps "google" and "apple" to the Zitadel IdP ids each button may
	// use. An intent from any other IdP is refused even if it is configured
	// on the org: see idpFinish.
	IDPs    map[string]string
	Deleter IdentityDeleter
}

type Handler struct {
	cfg     Config
	zitadel *zitadel

	// Per-email windows. In process, like ratelimit's only other user: one
	// replica makes them exact, and they cannot fail open.
	signIns   *ratelimit.Window
	signUps   *ratelimit.Window
	codes     *ratelimit.Window
	mailSends *ratelimit.Window
}

func NewHandler(cfg Config) *Handler {
	h := &Handler{
		cfg: cfg,
		// Generous enough for typos, tight enough that Zitadel's own lockout
		// (10 password attempts) is reached slowly rather than in a burst.
		signIns: ratelimit.NewWindow(10, 15*time.Minute),
		signUps: ratelimit.NewWindow(5, time.Hour),
		// Verification and reset codes are 6 characters; this bounds guessing
		// one at the rate a person types, not the rate a script does.
		codes:     ratelimit.NewWindow(10, 15*time.Minute),
		mailSends: ratelimit.NewWindow(5, time.Hour),
	}
	if strings.TrimSpace(cfg.Token) != "" {
		h.zitadel = newZitadel(cfg.Issuer, cfg.ProjectID, cfg.Token)
	}
	return h
}

func (h *Handler) Mount(r *gin.Engine) {
	g := r.Group("/v1/auth")
	g.POST("/sign-in", h.signIn)
	g.POST("/sign-up", h.signUp)
	g.POST("/verify-email", h.verifyEmail)
	g.POST("/resend-code", h.resendCode)
	g.POST("/password-reset", h.passwordReset)
	g.POST("/password-reset/confirm", h.passwordResetConfirm)
	g.POST("/idp/start", h.idpStart)
	g.POST("/idp/finish", h.idpFinish)
}

func (h *Handler) ready(c *gin.Context) bool {
	if h.zitadel == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "sign_in_unavailable", "Sign-in is unavailable right now. Please try again later.")
		return false
	}
	return true
}

func unavailable(c *gin.Context, op string, err error) {
	slog.Error("signin: "+op, "err", err)
	httpx.Error(c, http.StatusServiceUnavailable, "sign_in_unavailable", "Sign-in is unavailable right now. Please try again in a moment.")
}

func limited(c *gin.Context, w *ratelimit.Window, key string) bool {
	if w.Allow(key, time.Now()) {
		return false
	}
	httpx.Error(c, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Please wait a few minutes and try again.")
	return true
}

// normalEmail is the email as a rate-limit and lookup key. Zitadel matches
// emails ignoring case, so the limit must too or case variants multiply it.
func normalEmail(raw string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndexByte(email, '@')
	if at < 1 || at == len(email)-1 || len(email) > 254 || strings.ContainsAny(email, " \t\r\n") {
		return "", false
	}
	return email, true
}

// PKCE S256 challenges are 43 base64url characters: SHA-256 without padding.
var codeChallengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type completion struct {
	Platform      string `json:"platform"`
	CodeChallenge string `json:"code_challenge"`
}

func (h *Handler) clientID(c *gin.Context, req completion) (string, bool) {
	id := h.cfg.ClientIDs[req.Platform]
	if id == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "platform must be ios or android")
		return "", false
	}
	if !codeChallengePattern.MatchString(req.CodeChallenge) {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "code_challenge must be an S256 PKCE challenge")
		return "", false
	}
	return id, true
}

// complete turns a checked session into an authorization code for the app.
//
// Zitadel does NOT enforce MFA for a login client: it finalises a
// password-only session under forceMfa without complaint (mark8ly verified
// this on the same instance). Kora collects no second factor, so it refuses
// rather than silently skipping one, both when policy demands one and when the
// user has enrolled one. Unknown method types fail closed the same way.
func (h *Handler) complete(c *gin.Context, userID string, s session, federated bool, req completion, clientID string) {
	ctx := c.Request.Context()
	settings, err := h.zitadel.loginSettings(ctx)
	if err != nil {
		unavailable(c, "read login settings", err)
		return
	}
	if settings.ForceMFA || (settings.ForceMFALocalOnly && !federated) {
		secondFactorRequired(c)
		return
	}
	methods, err := h.zitadel.authMethods(ctx, userID)
	if err != nil {
		unavailable(c, "read auth methods", err)
		return
	}
	for _, m := range methods {
		if m != "AUTHENTICATION_METHOD_TYPE_PASSWORD" && m != "AUTHENTICATION_METHOD_TYPE_IDP" {
			secondFactorRequired(c)
			return
		}
	}

	state, err := randomState()
	if err != nil {
		unavailable(c, "state", err)
		return
	}
	authRequestID, err := h.zitadel.authRequest(ctx, clientID, RedirectURI, req.CodeChallenge, state)
	if err != nil {
		unavailable(c, "open auth request", err)
		return
	}
	callback, err := h.zitadel.finalize(ctx, authRequestID, s)
	if err != nil {
		unavailable(c, "finalize auth request", err)
		return
	}
	code, err := codeFromCallback(callback, state)
	if err != nil {
		unavailable(c, "read callback", err)
		return
	}
	httpx.OK(c, gin.H{"code": code})
}

func secondFactorRequired(c *gin.Context) {
	httpx.Error(c, http.StatusForbidden, "second_factor_required",
		"This account uses two-step verification, which the Kora app does not support yet.")
}

func randomState() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// codeFromCallback reads the code from the callback URL Zitadel built, after
// checking it is the redirect URI and carries the state this request sent.
func codeFromCallback(callback, state string) (string, error) {
	base, query, _ := strings.Cut(callback, "?")
	if base != RedirectURI {
		return "", errors.New("callback is not the kora redirect uri")
	}
	q, err := url.ParseQuery(query)
	if err != nil {
		return "", err
	}
	if q.Get("state") != state {
		return "", errors.New("callback state mismatch")
	}
	if e := q.Get("error"); e != "" {
		return "", errors.New("callback error " + e)
	}
	code := q.Get("code")
	if code == "" {
		return "", errors.New("callback without a code")
	}
	return code, nil
}

// pick chooses the one account an email names. Exactly one verified account
// wins; otherwise exactly one account of any kind. Anything else is
// ambiguous and the caller refuses rather than guessing whose it is.
func pick(users []user) (user, bool) {
	var verified []user
	for _, u := range users {
		if u.emailVerified {
			verified = append(verified, u)
		}
	}
	switch {
	case len(verified) == 1:
		return verified[0], true
	case len(verified) == 0 && len(users) == 1:
		return users[0], true
	}
	return user{}, false
}

type signInRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	completion
}

func (h *Handler) signIn(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req signInRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	email, ok := normalEmail(req.Email)
	if !ok || req.Password == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "email and password are required")
		return
	}
	clientID, ok := h.clientID(c, req.completion)
	if !ok || limited(c, h.signIns, email) {
		return
	}
	ctx := c.Request.Context()

	users, err := h.zitadel.usersByEmail(ctx, email)
	if err != nil {
		unavailable(c, "find user", err)
		return
	}
	// No account, an ambiguous one and a wrong password answer identically.
	u, found := pick(users)
	if !found {
		invalidCredentials(c)
		return
	}
	s, err := h.zitadel.passwordSession(ctx, u.id, req.Password)
	if errors.Is(err, errRejected) || errors.Is(err, errNotFound) {
		invalidCredentials(c)
		return
	}
	if err != nil {
		unavailable(c, "password session", err)
		return
	}
	// Only after the password is proven: otherwise this would tell anyone
	// which addresses have an unfinished sign-up.
	if !u.emailVerified {
		if err := h.zitadel.resendEmailCode(ctx, u.id); err != nil {
			slog.Warn("signin: resend code on unverified sign-in", "err", err)
		}
		httpx.Error(c, http.StatusForbidden, "email_not_verified", "Check your email for a code to confirm your address.")
		return
	}
	h.complete(c, u.id, s, false, req.completion, clientID)
}

func invalidCredentials(c *gin.Context) {
	httpx.Error(c, http.StatusUnauthorized, "invalid_credentials", "That email and password don't match. Try again or reset your password.")
}

type signUpRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *Handler) signUp(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req signUpRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	name := strings.Join(strings.Fields(req.Name), " ")
	email, ok := normalEmail(req.Email)
	switch {
	case name == "" || utf8.RuneCountInString(name) > 100:
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Enter your name.")
		return
	case !ok:
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Enter a valid email address.")
		return
	case req.Password == "":
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Choose a password.")
		return
	}
	if limited(c, h.signUps, email) {
		return
	}
	ctx := c.Request.Context()

	if !h.clearUnverified(c, email) {
		return
	}
	_, err := h.zitadel.createPasswordUser(ctx, profileFromName(name, email), email, req.Password)
	switch {
	case errors.Is(err, errWeakPassword):
		weakPassword(c)
	case errors.Is(err, errAlreadyExists):
		emailTaken(c)
	case errors.Is(err, errRejected):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Check your details and try again.")
	case err != nil:
		unavailable(c, "create user", err)
	default:
		c.JSON(http.StatusAccepted, gin.H{"data": gin.H{"verification_sent": true}})
	}
}

// clearUnverified makes way for a sign-up or a first federated sign-in on
// email. A verified account means the address is taken. Unverified ones are
// deleted: nobody ever proved they own the address, and leaving them would
// lock the person now proving it out of every sign-up path. Reports whether
// the caller may go on to create an account; when not, it has answered.
func (h *Handler) clearUnverified(c *gin.Context, email string) bool {
	users, err := h.zitadel.usersByEmail(c.Request.Context(), email)
	if err != nil {
		unavailable(c, "find user", err)
		return false
	}
	for _, u := range users {
		if u.emailVerified {
			emailTaken(c)
			return false
		}
	}
	for _, u := range users {
		if h.cfg.Deleter == nil {
			emailTaken(c)
			return false
		}
		if err := h.cfg.Deleter.DeleteIdentity(c.Request.Context(), u.id); err != nil {
			unavailable(c, "delete unverified user", err)
			return false
		}
	}
	return true
}

func emailTaken(c *gin.Context) {
	httpx.Error(c, http.StatusConflict, "email_taken", "An account with this email already exists. Sign in instead.")
}

func weakPassword(c *gin.Context) {
	httpx.Error(c, http.StatusUnprocessableEntity, "weak_password",
		"Use at least 12 characters with upper and lower case letters, a number and a symbol.")
}

// profileFromName splits a single name field into the given and family names
// Zitadel requires, keeping the whole name as the display name so nothing the
// person typed is lost or reordered.
func profileFromName(name, email string) profile {
	given, family, _ := strings.Cut(name, " ")
	if given == "" {
		given, _, _ = strings.Cut(email, "@")
	}
	if family == "" {
		family = given
	}
	return profile{givenName: given, familyName: family, displayName: name}
}

type codeRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

func (h *Handler) verifyEmail(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req codeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	email, ok := normalEmail(req.Email)
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	if !ok || code == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "email and code are required")
		return
	}
	if limited(c, h.codes, email) {
		return
	}
	ctx := c.Request.Context()
	users, err := h.zitadel.usersByEmail(ctx, email)
	if err != nil {
		unavailable(c, "find user", err)
		return
	}
	u, found := pick(users)
	if !found {
		invalidCode(c)
		return
	}
	if u.emailVerified {
		// Already done, on another device or a double tap.
		httpx.OK(c, gin.H{"verified": true})
		return
	}
	err = h.zitadel.verifyEmail(ctx, u.id, code)
	switch {
	case errors.Is(err, errInvalidCode):
		invalidCode(c)
	case err != nil:
		unavailable(c, "verify email", err)
	default:
		httpx.OK(c, gin.H{"verified": true})
	}
}

func invalidCode(c *gin.Context) {
	httpx.Error(c, http.StatusBadRequest, "invalid_code", "That code is wrong or has expired. Check it, or send a new one.")
}

type emailRequest struct {
	Email string `json:"email"`
}

// resendCode mails a fresh verification code. It answers 202 whether or not
// the address has an unverified account, so it reveals nothing about either.
func (h *Handler) resendCode(c *gin.Context) {
	h.mailToAccount(c, "resend code", func(ctx context.Context, u user) error {
		if u.emailVerified {
			return nil
		}
		return h.zitadel.resendEmailCode(ctx, u.id)
	})
}

// passwordReset mails a reset code, answering 202 either way like resendCode.
func (h *Handler) passwordReset(c *gin.Context) {
	h.mailToAccount(c, "password reset", func(ctx context.Context, u user) error {
		return h.zitadel.requestPasswordReset(ctx, u.id)
	})
}

func (h *Handler) mailToAccount(c *gin.Context, op string, send func(context.Context, user) error) {
	if !h.ready(c) {
		return
	}
	var req emailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	email, ok := normalEmail(req.Email)
	if !ok {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Enter a valid email address.")
		return
	}
	if limited(c, h.mailSends, email) {
		return
	}
	ctx := c.Request.Context()
	users, err := h.zitadel.usersByEmail(ctx, email)
	if err != nil {
		unavailable(c, "find user", err)
		return
	}
	if u, found := pick(users); found {
		// Logged, not surfaced: a failure answered differently would say the
		// account exists.
		if err := send(ctx, u); err != nil {
			slog.Error("signin: "+op, "err", err)
		}
	}
	c.JSON(http.StatusAccepted, gin.H{"data": gin.H{"sent": true}})
}

type resetConfirmRequest struct {
	Email    string `json:"email"`
	Code     string `json:"code"`
	Password string `json:"password"`
}

func (h *Handler) passwordResetConfirm(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req resetConfirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	email, ok := normalEmail(req.Email)
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	if !ok || code == "" || req.Password == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "email, code and password are required")
		return
	}
	if limited(c, h.codes, email) {
		return
	}
	ctx := c.Request.Context()
	users, err := h.zitadel.usersByEmail(ctx, email)
	if err != nil {
		unavailable(c, "find user", err)
		return
	}
	u, found := pick(users)
	if !found {
		invalidCode(c)
		return
	}
	err = h.zitadel.setPassword(ctx, u.id, code, req.Password)
	switch {
	case errors.Is(err, errWeakPassword):
		weakPassword(c)
	case errors.Is(err, errInvalidCode):
		invalidCode(c)
	case err != nil:
		unavailable(c, "set password", err)
	default:
		httpx.OK(c, gin.H{"reset": true})
	}
}

type idpStartRequest struct {
	Provider string `json:"provider"`
}

func (h *Handler) idpStart(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req idpStartRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	idpID := h.cfg.IDPs[req.Provider]
	if idpID == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "provider must be google or apple")
		return
	}
	authURL, err := h.zitadel.startIntent(c.Request.Context(), idpID, IDPCallbackURL, IDPCallbackURL)
	if err != nil {
		unavailable(c, "start idp intent", err)
		return
	}
	httpx.OK(c, gin.H{"auth_url": authURL})
}

type idpFinishRequest struct {
	Provider    string `json:"provider"`
	IntentID    string `json:"intent_id"`
	IntentToken string `json:"intent_token"`
	completion
}

// idpFinish signs in with a finished Google or Apple intent, creating or
// linking the Kora account on first use.
//
// The identity comes only from retrieving the intent with its token. The
// `user` parameter Zitadel adds to the callback URL rode through a browser and
// is never read. The intent must come from the IdP the request names: an
// intent from another IdP on the org would otherwise be trusted like this
// one, including its email_verified claim.
func (h *Handler) idpFinish(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	var req idpFinishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	idpID := h.cfg.IDPs[req.Provider]
	if idpID == "" || req.IntentID == "" || req.IntentToken == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "provider, intent_id and intent_token are required")
		return
	}
	clientID, ok := h.clientID(c, req.completion)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	identity, err := h.zitadel.retrieveIntent(ctx, req.IntentID, req.IntentToken)
	if errors.Is(err, errRejected) || errors.Is(err, errNotFound) {
		invalidIntent(c)
		return
	}
	if err != nil {
		unavailable(c, "retrieve idp intent", err)
		return
	}
	if identity.idpID != idpID {
		invalidIntent(c)
		return
	}

	userID := identity.zitadelUserID
	if userID == "" {
		var done bool
		if userID, done = h.provisionFederated(c, identity); done {
			return
		}
	}
	s, err := h.zitadel.intentSession(ctx, userID, req.IntentID, req.IntentToken)
	if errors.Is(err, errRejected) || errors.Is(err, errNotFound) {
		invalidIntent(c)
		return
	}
	if err != nil {
		unavailable(c, "intent session", err)
		return
	}
	h.complete(c, userID, s, true, req.completion, clientID)
}

func invalidIntent(c *gin.Context) {
	httpx.Error(c, http.StatusBadRequest, "invalid_intent", "That sign-in didn't complete. Please try again.")
}

// provisionFederated finds or creates the account for an identity not yet
// linked to one. It requires a provider-verified email, absolutely: linking on
// an unverified one is how a federated sign-in becomes account takeover, by
// registering a victim's address at the provider. Reports done when it has
// answered the request itself.
func (h *Handler) provisionFederated(c *gin.Context, identity federatedIdentity) (string, bool) {
	email, ok := normalEmail(identity.email)
	if !ok || !identity.emailVerified {
		httpx.Error(c, http.StatusForbidden, "email_not_verified",
			"Your account with this provider has no verified email, so Kora can't use it to sign you in.")
		return "", true
	}
	ctx := c.Request.Context()
	users, err := h.zitadel.usersByEmail(ctx, email)
	if err != nil {
		unavailable(c, "find user", err)
		return "", true
	}
	var verified []user
	for _, u := range users {
		if u.emailVerified {
			verified = append(verified, u)
		}
	}
	switch len(verified) {
	case 0:
	case 1:
		if err := h.zitadel.linkIdentity(ctx, verified[0].id, identity); err != nil {
			unavailable(c, "link identity", err)
			return "", true
		}
		return verified[0].id, false
	default:
		httpx.Error(c, http.StatusConflict, "email_ambiguous", "More than one account uses this email. Contact support.")
		return "", true
	}

	if !h.clearUnverified(c, email) {
		return "", true
	}
	given := identity.givenName
	if given == "" {
		given, _, _ = strings.Cut(email, "@")
	}
	display := strings.TrimSpace(given + " " + identity.familyName)
	family := identity.familyName
	if family == "" {
		family = given
	}
	userID, err := h.zitadel.createFederatedUser(ctx, profile{givenName: given, familyName: family, displayName: display}, identity)
	if errors.Is(err, errAlreadyExists) {
		emailTaken(c)
		return "", true
	}
	if err != nil {
		unavailable(c, "create federated user", err)
		return "", true
	}
	return userID, false
}
