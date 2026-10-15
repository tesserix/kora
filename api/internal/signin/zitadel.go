package signin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Errors the flows branch on. Everything else a Zitadel call can fail with is
// errUnavailable: the caller answers 503 and the user retries, rather than this
// package guessing at a meaning Zitadel did not state.
var (
	errUnavailable   = errors.New("signin: zitadel unavailable")
	errRejected      = errors.New("signin: zitadel rejected the request")
	errNotFound      = errors.New("signin: not found")
	errAlreadyExists = errors.New("signin: already exists")
	errWeakPassword  = errors.New("signin: password does not meet the policy")
	errInvalidCode   = errors.New("signin: code is wrong or expired")
)

// Zitadel error ids (details[0].id) with a meaning of their own. Matched
// exactly, never by prefix: two COMMAND- ids can mean unrelated things.
const weakPasswordErrorID = "DOMAIN-HuJf6"

const maxZitadelResponse = 1 << 20

// zitadel speaks the slice of Zitadel's v2 login-client API Kora's own sign-in
// screens need, authenticated with the kora-login-client PAT. That machine user
// holds IAM_LOGIN_CLIENT, which can mint a session for ANY user on the
// instance: never log the token, and never let a request reach Zitadel with a
// user id the caller chose rather than one Zitadel resolved.
//
// The request and response shapes follow mark8ly auth-bff's
// internal/zitadellogin, which pinned them against the same v4.15.3 instance.
type zitadel struct {
	issuer    string
	projectID string
	token     string
	http      *http.Client

	// self is the login client's own user id and org, read once from
	// /auth/v1/users/me. The id goes on x-zitadel-login-client; the org is
	// TESSERIX, where Kora users self-register.
	selfMu sync.Mutex
	self   *loginClient
}

type loginClient struct {
	userID string
	orgID  string
}

func newZitadel(issuer, projectID, token string) *zitadel {
	return &zitadel{
		issuer:    strings.TrimSuffix(issuer, "/"),
		projectID: projectID,
		token:     token,
		http: &http.Client{
			Timeout: 10 * time.Second,
			// Never forward the login-client token to wherever a redirect points.
			// Also what keeps /oauth/v2/authorize's 302 readable: see authRequest.
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

type zitadelError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Details []struct {
		ID string `json:"id"`
	} `json:"details"`
}

func (e zitadelError) id() string {
	if len(e.Details) == 0 {
		return ""
	}
	return e.Details[0].ID
}

// do sends one authenticated JSON request. A 2xx decodes into out; anything
// else becomes a zitadelStatus the caller classifies, so the status and error
// id survive to the one place that knows what they mean for this call.
func (z *zitadel) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("signin: encode %s: %w", path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, z.issuer+path, reader)
	if err != nil {
		return fmt.Errorf("signin: build %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+z.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := z.http.Do(req)
	if err != nil {
		return fmt.Errorf("signin: %s %s: %w", method, logPath(path), errors.Join(errUnavailable, err))
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxZitadelResponse))
	if err != nil {
		return fmt.Errorf("signin: read %s: %w", logPath(path), errors.Join(errUnavailable, err))
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var ze zitadelError
		_ = json.Unmarshal(raw, &ze)
		return &zitadelStatus{status: res.StatusCode, id: ze.id(), path: logPath(path)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("signin: decode %s: %w", logPath(path), errors.Join(errUnavailable, err))
	}
	return nil
}

// zitadelStatus is a non-2xx answer. Unwrap maps it onto the package's sentinel
// errors by status alone; calls with a more specific reading classify it first.
type zitadelStatus struct {
	status int
	id     string
	path   string
}

func (e *zitadelStatus) Error() string {
	return fmt.Sprintf("signin: %s: status %d %s", e.path, e.status, e.id)
}

func (e *zitadelStatus) Unwrap() error {
	switch {
	case e.status == http.StatusNotFound:
		return errNotFound
	case e.status == http.StatusConflict:
		return errAlreadyExists
	case e.status == http.StatusBadRequest || e.status == http.StatusPreconditionFailed:
		return errRejected
	default:
		return errUnavailable
	}
}

// logPath drops ids from a path before it reaches an error string: user ids,
// session ids and intent ids are request-scoped input with no business in logs.
func logPath(path string) string {
	path, _, _ = strings.Cut(path, "?")
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if len(p) > 0 && (p[0] >= '0' && p[0] <= '9' || strings.HasPrefix(p, "V2_")) {
			parts[i] = "{id}"
		}
	}
	return strings.Join(parts, "/")
}

// loginClient reads the login client's own identity, caching it once read. A
// failure is not cached, so a Zitadel blip at the first sign-in is retried by
// the next one instead of breaking sign-in until a restart.
func (z *zitadel) loginClient(ctx context.Context) (loginClient, error) {
	z.selfMu.Lock()
	defer z.selfMu.Unlock()
	if z.self != nil {
		return *z.self, nil
	}
	var wire struct {
		User struct {
			ID      string `json:"id"`
			Details struct {
				ResourceOwner string `json:"resourceOwner"`
			} `json:"details"`
		} `json:"user"`
	}
	if err := z.do(ctx, http.MethodGet, "/auth/v1/users/me", nil, &wire); err != nil {
		return loginClient{}, err
	}
	if wire.User.ID == "" || wire.User.Details.ResourceOwner == "" {
		return loginClient{}, fmt.Errorf("signin: /auth/v1/users/me without an id or org: %w", errUnavailable)
	}
	z.self = &loginClient{userID: wire.User.ID, orgID: wire.User.Details.ResourceOwner}
	return *z.self, nil
}

// authRequest opens an OIDC authorization request for a Kora native client
// and returns its id. The app made the PKCE pair and keeps the verifier; only
// the challenge comes here, so the code this request ends in is useless to
// anyone but the app that asked for it, kora-api included.
//
// x-zitadel-login-client makes Zitadel create a v2 request (V2_...) bound to
// this login client, without kora-ios or kora-android being switched to Login
// V2. The 302 is read, never followed: following it fetches the hosted login
// page and loses the id.
func (z *zitadel) authRequest(ctx context.Context, clientID, redirectURI, codeChallenge, state string) (string, error) {
	self, err := z.loginClient(ctx)
	if err != nil {
		return "", err
	}
	q := url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {redirectURI},
		"response_type":         {"code"},
		"scope":                 {"openid profile email offline_access urn:zitadel:iam:org:project:id:" + z.projectID + ":aud"},
		"state":                 {state},
		"code_challenge":        {codeChallenge},
		"code_challenge_method": {"S256"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, z.issuer+"/oauth/v2/authorize?"+q.Encode(), nil)
	if err != nil {
		return "", fmt.Errorf("signin: build authorize: %w", err)
	}
	req.Header.Set("x-zitadel-login-client", self.userID)
	res, err := z.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("signin: authorize: %w", errors.Join(errUnavailable, err))
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxZitadelResponse))
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil || res.StatusCode != http.StatusFound {
		return "", fmt.Errorf("signin: authorize answered %d: %w", res.StatusCode, errUnavailable)
	}
	id := loc.Query().Get("authRequest")
	if !strings.HasPrefix(id, "V2_") {
		// A client_id or redirect_uri mismatch redirects to the callback with
		// ?error= instead, which also lands here.
		return "", fmt.Errorf("signin: authorize redirect carried no v2 auth request (error=%q): %w",
			loc.Query().Get("error"), errUnavailable)
	}
	return id, nil
}

type session struct {
	id    string
	token string
}

// passwordSession checks userID's password and opens a session on success. A
// wrong password, a locked user and a user with no password all come back as
// errRejected; collapsing them into one answer is the caller's job.
func (z *zitadel) passwordSession(ctx context.Context, userID, password string) (session, error) {
	return z.createSession(ctx, map[string]any{
		"user":     map[string]any{"userId": userID},
		"password": map[string]any{"password": password},
	})
}

// intentSession opens a session from a completed IdP intent. The user check is
// required alongside the intent: Zitadel's CheckIntent fails with
// COMMAND-Sfw3r unless a user check has already named the user, so the intent
// confirms the link rather than resolving who the user is.
func (z *zitadel) intentSession(ctx context.Context, userID, intentID, intentToken string) (session, error) {
	return z.createSession(ctx, map[string]any{
		"user":      map[string]any{"userId": userID},
		"idpIntent": map[string]any{"idpIntentId": intentID, "idpIntentToken": intentToken},
	})
}

func (z *zitadel) createSession(ctx context.Context, checks map[string]any) (session, error) {
	var wire struct {
		SessionID    string `json:"sessionId"`
		SessionToken string `json:"sessionToken"`
	}
	if err := z.do(ctx, http.MethodPost, "/v2/sessions", map[string]any{"checks": checks}, &wire); err != nil {
		return session{}, err
	}
	if wire.SessionID == "" || wire.SessionToken == "" {
		return session{}, fmt.Errorf("signin: session created without an id or token: %w", errUnavailable)
	}
	return session{id: wire.SessionID, token: wire.SessionToken}, nil
}

// checkTOTP adds an authenticator-app code to s. Zitadel answers with a new
// session token, which replaces s's: the old one no longer finalizes.
func (z *zitadel) checkTOTP(ctx context.Context, s session, code string) (session, error) {
	var wire struct {
		SessionToken string `json:"sessionToken"`
	}
	body := map[string]any{"sessionToken": s.token, "checks": map[string]any{"totp": map[string]any{"code": code}}}
	err := z.do(ctx, http.MethodPatch, "/v2/sessions/"+url.PathEscape(s.id), body, &wire)
	if errors.Is(err, errRejected) {
		return session{}, errors.Join(errInvalidCode, err)
	}
	if err != nil {
		return session{}, err
	}
	if wire.SessionToken == "" {
		return session{}, fmt.Errorf("signin: totp check without a session token: %w", errUnavailable)
	}
	return session{id: s.id, token: wire.SessionToken}, nil
}

type totpSetup struct {
	URI    string `json:"uri"`
	Secret string `json:"secret"`
}

// registerTOTP starts adding an authenticator app to userID: the otpauth URI
// and secret the app imports. Nothing is enrolled until verifyTOTPRegistration
// accepts a code from it, and a second call replaces an unconfirmed start.
func (z *zitadel) registerTOTP(ctx context.Context, userID string) (totpSetup, error) {
	var wire totpSetup
	if err := z.do(ctx, http.MethodPost, "/v2/users/"+url.PathEscape(userID)+"/totp", map[string]any{}, &wire); err != nil {
		return totpSetup{}, err
	}
	if wire.URI == "" || wire.Secret == "" {
		return totpSetup{}, fmt.Errorf("signin: totp registration without a uri or secret: %w", errUnavailable)
	}
	return wire, nil
}

// verifyTOTPRegistration enrolls userID's authenticator app once it proves it
// generates the right codes.
func (z *zitadel) verifyTOTPRegistration(ctx context.Context, userID, code string) error {
	err := z.do(ctx, http.MethodPost, "/v2/users/"+url.PathEscape(userID)+"/totp/verify",
		map[string]any{"code": code}, nil)
	if errors.Is(err, errRejected) {
		return errors.Join(errInvalidCode, err)
	}
	return err
}

// removeTOTP removes userID's authenticator app.
func (z *zitadel) removeTOTP(ctx context.Context, userID string) error {
	return z.do(ctx, http.MethodDelete, "/v2/users/"+url.PathEscape(userID)+"/totp", nil, nil)
}

// totpSession proves code is userID's current authenticator code by opening a
// session on it. The session is a proof and nothing more, so it is ended
// straight away; a failure to end it leaves only an idle session to expire.
func (z *zitadel) totpSession(ctx context.Context, userID, code string) error {
	s, err := z.createSession(ctx, map[string]any{
		"user": map[string]any{"userId": userID},
		"totp": map[string]any{"code": code},
	})
	if errors.Is(err, errRejected) {
		return errors.Join(errInvalidCode, err)
	}
	if err != nil {
		return err
	}
	if err := z.do(ctx, http.MethodDelete, "/v2/sessions/"+url.PathEscape(s.id),
		map[string]any{"sessionToken": s.token}, nil); err != nil {
		slog.Warn("signin: end totp proof session", "err", err)
	}
	return nil
}

// finalize ends authRequestID with s and returns the callback URL Zitadel
// built: the client's redirect URI carrying the code and state.
func (z *zitadel) finalize(ctx context.Context, authRequestID string, s session) (string, error) {
	var wire struct {
		CallbackURL string `json:"callbackUrl"`
	}
	body := map[string]any{"session": map[string]any{"sessionId": s.id, "sessionToken": s.token}}
	if err := z.do(ctx, http.MethodPost, "/v2/oidc/auth_requests/"+url.PathEscape(authRequestID), body, &wire); err != nil {
		return "", err
	}
	if wire.CallbackURL == "" {
		return "", fmt.Errorf("signin: finalize without a callbackUrl: %w", errUnavailable)
	}
	return wire.CallbackURL, nil
}

type user struct {
	id            string
	email         string
	emailVerified bool
	givenName     string
}

// usersByEmail lists the users in Kora's org whose email matches, ignoring
// case the way Zitadel's own uniqueness does. Scoped to the org because email
// is unique only per org, and this token reaches every org on the instance.
func (z *zitadel) usersByEmail(ctx context.Context, email string) ([]user, error) {
	self, err := z.loginClient(ctx)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"query": map[string]any{"limit": 10},
		"queries": []any{
			map[string]any{"emailQuery": map[string]any{"emailAddress": email, "method": "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE"}},
			map[string]any{"organizationIdQuery": map[string]any{"organizationId": self.orgID}},
		},
	}
	var wire struct {
		Result []struct {
			UserID string `json:"userId"`
			Human  *struct {
				Profile struct {
					GivenName string `json:"givenName"`
				} `json:"profile"`
				Email struct {
					Email      string `json:"email"`
					IsVerified bool   `json:"isVerified"`
				} `json:"email"`
			} `json:"human"`
		} `json:"result"`
	}
	if err := z.do(ctx, http.MethodPost, "/v2/users", body, &wire); err != nil {
		return nil, err
	}
	var out []user
	for _, r := range wire.Result {
		// Re-checked here: the search is the server's reading of the query, and
		// a match on anything but this exact address must not become an account.
		if r.Human == nil || !strings.EqualFold(r.Human.Email.Email, email) {
			continue
		}
		out = append(out, user{id: r.UserID, email: r.Human.Email.Email, emailVerified: r.Human.Email.IsVerified, givenName: r.Human.Profile.GivenName})
	}
	return out, nil
}

// authMethods lists the authentication methods userID has enrolled, such as
// AUTHENTICATION_METHOD_TYPE_PASSWORD or AUTHENTICATION_METHOD_TYPE_TOTP.
func (z *zitadel) authMethods(ctx context.Context, userID string) ([]string, error) {
	var wire struct {
		AuthMethodTypes []string `json:"authMethodTypes"`
	}
	if err := z.do(ctx, http.MethodGet, "/v2/users/"+url.PathEscape(userID)+"/authentication_methods", nil, &wire); err != nil {
		return nil, err
	}
	return wire.AuthMethodTypes, nil
}

type loginSettings struct {
	ForceMFA          bool `json:"forceMfa"`
	ForceMFALocalOnly bool `json:"forceMfaLocalOnly"`
}

// loginSettings reads the login policy that applies to Kora's org.
func (z *zitadel) loginSettings(ctx context.Context) (loginSettings, error) {
	self, err := z.loginClient(ctx)
	if err != nil {
		return loginSettings{}, err
	}
	var wire struct {
		Settings loginSettings `json:"settings"`
	}
	if err := z.do(ctx, http.MethodGet, "/v2/settings/login?ctx.orgId="+url.QueryEscape(self.orgID), nil, &wire); err != nil {
		return loginSettings{}, err
	}
	return wire.Settings, nil
}

type profile struct {
	givenName   string
	familyName  string
	displayName string
}

// createPasswordUser registers a human with an unverified email. With
// returnCode the verification code comes back for Kora to mail; without it
// Zitadel mails it. Weak passwords and taken emails come back as their own
// errors so the sign-up screen can say which.
func (z *zitadel) createPasswordUser(ctx context.Context, p profile, email, password string, returnCode bool) (id, code string, err error) {
	self, err := z.loginClient(ctx)
	if err != nil {
		return "", "", err
	}
	emailBody := codeDelivery(returnCode)
	emailBody["email"] = email
	body := map[string]any{
		"organization": map[string]any{"orgId": self.orgID},
		"profile":      profileBody(p),
		"email":        emailBody,
		"password":     map[string]any{"password": password, "changeRequired": false},
	}
	var wire struct {
		UserID    string `json:"userId"`
		EmailCode string `json:"emailCode"`
	}
	if err := z.createUser(ctx, body, &wire); err != nil {
		return "", "", err
	}
	if wire.UserID == "" {
		return "", "", errNoUserID()
	}
	if returnCode && wire.EmailCode == "" {
		return "", "", fmt.Errorf("signin: user created without a code: %w", errUnavailable)
	}
	return wire.UserID, wire.EmailCode, nil
}

// codeDelivery is the request fragment choosing who sends a code: returnCode
// hands it to kora-api, sendCode has Zitadel mail it.
func codeDelivery(returnCode bool) map[string]any {
	if returnCode {
		return map[string]any{"returnCode": map[string]any{}}
	}
	return map[string]any{"sendCode": map[string]any{}}
}

type federatedIdentity struct {
	idpID         string
	externalID    string
	externalName  string
	zitadelUserID string
	email         string
	emailVerified bool
	givenName     string
	familyName    string
}

// createFederatedUser registers a human already linked to identity. Only
// called for an identity whose provider verified the email, so the email is
// created verified rather than sent a code the user has no reason to expect.
func (z *zitadel) createFederatedUser(ctx context.Context, p profile, identity federatedIdentity) (string, error) {
	self, err := z.loginClient(ctx)
	if err != nil {
		return "", err
	}
	body := map[string]any{
		"organization": map[string]any{"orgId": self.orgID},
		"profile":      profileBody(p),
		"email":        map[string]any{"email": identity.email, "isVerified": true},
		"idpLinks":     []any{idpLinkBody(identity)},
	}
	var wire struct {
		UserID string `json:"userId"`
	}
	if err := z.createUser(ctx, body, &wire); err != nil {
		return "", err
	}
	if wire.UserID == "" {
		return "", errNoUserID()
	}
	return wire.UserID, nil
}

// createUser posts body to /v2/users/human, decoding the answer into wire.
func (z *zitadel) createUser(ctx context.Context, body map[string]any, wire any) error {
	if err := z.do(ctx, http.MethodPost, "/v2/users/human", body, wire); err != nil {
		var st *zitadelStatus
		if errors.As(err, &st) && st.id == weakPasswordErrorID {
			return errors.Join(errWeakPassword, err)
		}
		return err
	}
	return nil
}

func errNoUserID() error {
	return fmt.Errorf("signin: user created without an id: %w", errUnavailable)
}

func profileBody(p profile) map[string]any {
	return map[string]any{"givenName": p.givenName, "familyName": p.familyName, "displayName": p.displayName}
}

func idpLinkBody(identity federatedIdentity) map[string]any {
	return map[string]any{"idpId": identity.idpID, "userId": identity.externalID, "userName": identity.externalName}
}

// linkIdentity attaches identity to an existing user, so the next intent for
// the same provider account resolves to that user directly.
func (z *zitadel) linkIdentity(ctx context.Context, userID string, identity federatedIdentity) error {
	return z.do(ctx, http.MethodPost, "/v2/users/"+url.PathEscape(userID)+"/links",
		map[string]any{"idpLink": idpLinkBody(identity)}, nil)
}

// verifyEmail submits the emailed code. The path has no underscore:
// email/_verify is a routing 404 that would read as a wrong code.
func (z *zitadel) verifyEmail(ctx context.Context, userID, code string) error {
	err := z.do(ctx, http.MethodPost, "/v2/users/"+url.PathEscape(userID)+"/email/verify",
		map[string]any{"verificationCode": code}, nil)
	if errors.Is(err, errRejected) {
		return errors.Join(errInvalidCode, err)
	}
	return err
}

// resendEmailCode issues userID a fresh verification code, replacing the
// last: returned with returnCode, mailed by Zitadel without.
func (z *zitadel) resendEmailCode(ctx context.Context, userID string, returnCode bool) (string, error) {
	return z.issueCode(ctx, "/v2/users/"+url.PathEscape(userID)+"/email/resend", codeDelivery(returnCode), returnCode)
}

// requestPasswordReset issues userID a password reset code, the same way.
func (z *zitadel) requestPasswordReset(ctx context.Context, userID string, returnCode bool) (string, error) {
	body := map[string]any{"sendLink": map[string]any{"notificationType": "NOTIFICATION_TYPE_Email"}}
	if returnCode {
		body = codeDelivery(true)
	}
	return z.issueCode(ctx, "/v2/users/"+url.PathEscape(userID)+"/password_reset", body, returnCode)
}

func (z *zitadel) issueCode(ctx context.Context, path string, body map[string]any, returnCode bool) (string, error) {
	var wire struct {
		VerificationCode string `json:"verificationCode"`
	}
	if err := z.do(ctx, http.MethodPost, path, body, &wire); err != nil {
		return "", err
	}
	if returnCode && wire.VerificationCode == "" {
		return "", fmt.Errorf("signin: %s returned no code: %w", logPath(path), errUnavailable)
	}
	return wire.VerificationCode, nil
}

// setPassword replaces userID's password, authorised by the emailed reset code.
func (z *zitadel) setPassword(ctx context.Context, userID, code, password string) error {
	body := map[string]any{
		"newPassword":      map[string]any{"password": password, "changeRequired": false},
		"verificationCode": code,
	}
	err := z.do(ctx, http.MethodPost, "/v2/users/"+url.PathEscape(userID)+"/password", body, nil)
	var st *zitadelStatus
	switch {
	case errors.As(err, &st) && st.id == weakPasswordErrorID:
		return errors.Join(errWeakPassword, err)
	case errors.Is(err, errRejected):
		return errors.Join(errInvalidCode, err)
	}
	return err
}

// startIntent begins an IdP intent and returns the provider's own sign-in URL.
// Zitadel does not validate successURL or failureURL at all, so they must
// never come from the request: see Handler.idpStart.
func (z *zitadel) startIntent(ctx context.Context, idpID, successURL, failureURL string) (string, error) {
	body := map[string]any{
		"idpId": idpID,
		"urls":  map[string]any{"successUrl": successURL, "failureUrl": failureURL},
	}
	var wire struct {
		AuthURL string `json:"authUrl"`
	}
	if err := z.do(ctx, http.MethodPost, "/v2/idp_intents", body, &wire); err != nil {
		return "", err
	}
	if wire.AuthURL == "" {
		return "", fmt.Errorf("signin: idp intent without an authUrl: %w", errUnavailable)
	}
	return wire.AuthURL, nil
}

// retrieveIntent exchanges a finished intent's id and token for the identity
// the provider asserted. The intent token is bearer-equivalent: never log it.
func (z *zitadel) retrieveIntent(ctx context.Context, intentID, intentToken string) (federatedIdentity, error) {
	var wire struct {
		UserID         string `json:"userId"`
		IDPInformation struct {
			IDPID          string         `json:"idpId"`
			UserID         string         `json:"userId"`
			UserName       string         `json:"userName"`
			RawInformation map[string]any `json:"rawInformation"`
		} `json:"idpInformation"`
	}
	if err := z.do(ctx, http.MethodPost, "/v2/idp_intents/"+url.PathEscape(intentID),
		map[string]any{"idpIntentToken": intentToken}, &wire); err != nil {
		return federatedIdentity{}, err
	}
	raw := wire.IDPInformation.RawInformation
	email, verified := rawEmail(raw)
	return federatedIdentity{
		idpID:         wire.IDPInformation.IDPID,
		externalID:    wire.IDPInformation.UserID,
		externalName:  wire.IDPInformation.UserName,
		zitadelUserID: wire.UserID,
		email:         email,
		emailVerified: verified,
		givenName:     rawString(raw, "given_name"),
		familyName:    rawString(raw, "family_name"),
	}, nil
}

// rawEmail reads email and email_verified from the provider's raw claims.
// Apple documents email_verified as a string OR a boolean and has sent "true",
// so both are read; anything else, including an absent claim, is unverified.
func rawEmail(raw map[string]any) (string, bool) {
	email := rawString(raw, "email")
	switch v := raw["email_verified"].(type) {
	case bool:
		return email, v
	case string:
		return email, v == "true"
	}
	return email, false
}

func rawString(raw map[string]any, key string) string {
	v, _ := raw[key].(string)
	return strings.TrimSpace(v)
}
