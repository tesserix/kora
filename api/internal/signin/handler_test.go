package signin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

const (
	testOrg       = "org-tesserix"
	testClient    = "login-client-id"
	testGoogleIDP = "idp-google"
	testAppleIDP  = "idp-apple"
	testChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
)

type call struct {
	method string
	path   string
	query  url.Values
	header http.Header
	body   map[string]any
}

// fakeZitadel answers the login-client API from per-route handlers and records
// every call. Routes without a handler answer 500, so a flow reaching a call
// the test did not expect fails loudly instead of passing on a zero value.
type fakeZitadel struct {
	t      *testing.T
	mu     sync.Mutex
	calls  []call
	routes map[string]func(call) (int, any)
	srv    *httptest.Server
}

func newFake(t *testing.T) *fakeZitadel {
	f := &fakeZitadel{t: t, routes: map[string]func(call) (int, any){}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		c := call{method: r.Method, path: r.URL.Path, query: r.URL.Query(), header: r.Header.Clone(), body: body}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		h := f.routes[r.Method+" "+r.URL.Path]
		f.mu.Unlock()
		if h == nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		status, out := h(c)
		if loc, ok := out.(redirect); ok {
			w.Header().Set("Location", string(loc))
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(f.srv.Close)
	f.on("GET /auth/v1/users/me", 200, map[string]any{"user": map[string]any{
		"id": testClient, "details": map[string]any{"resourceOwner": testOrg},
	}})
	return f
}

type redirect string

func (f *fakeZitadel) on(route string, status int, body any) {
	f.handle(route, func(call) (int, any) { return status, body })
}

func (f *fakeZitadel) handle(route string, h func(call) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = h
}

func (f *fakeZitadel) called(method, path string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.method == method && c.path == path {
			out = append(out, c)
		}
	}
	return out
}

// users makes the email search return the given users.
func (f *fakeZitadel) users(us ...map[string]any) {
	f.on("POST /v2/users", 200, map[string]any{"result": us})
}

func human(id, email string, verified bool) map[string]any {
	return map[string]any{"userId": id, "human": map[string]any{"email": map[string]any{"email": email, "isVerified": verified}}}
}

// completes wires everything after a successful credential check: open
// policy, password-only methods, and an authorize/finalize pair that echoes
// the state kora-api chose back on the callback, as Zitadel does.
func (f *fakeZitadel) completes(methods ...string) {
	if len(methods) == 0 {
		methods = []string{"AUTHENTICATION_METHOD_TYPE_PASSWORD"}
	}
	f.on("GET /v2/settings/login", 200, map[string]any{"settings": map[string]any{}})
	f.handle("GET /v2/users/u-1/authentication_methods", func(call) (int, any) {
		return 200, map[string]any{"authMethodTypes": methods}
	})
	var state string
	f.handle("GET /oauth/v2/authorize", func(c call) (int, any) {
		state = c.query.Get("state")
		return http.StatusFound, redirect("/ui/v2/login/login?authRequest=V2_42")
	})
	f.handle("POST /v2/oidc/auth_requests/V2_42", func(call) (int, any) {
		return 200, map[string]any{"callbackUrl": RedirectURI + "?code=the-code&state=" + url.QueryEscape(state)}
	})
}

type recordingDeleter struct{ deleted []string }

func (d *recordingDeleter) DeleteIdentity(_ context.Context, subject string) error {
	d.deleted = append(d.deleted, subject)
	return nil
}

func newTestHandler(f *fakeZitadel, deleter IdentityDeleter) *gin.Engine {
	return newHandlerWith(f, func(c *Config) { c.Deleter = deleter })
}

func newHandlerWith(f *fakeZitadel, configure func(*Config)) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	cfg := Config{
		Issuer:    f.srv.URL,
		ProjectID: "proj-kora",
		Token:     "pat",
		ClientIDs: map[string]string{"ios": "client-ios", "android": "client-android"},
		IDPs:      map[string]string{"google": testGoogleIDP, "apple": testAppleIDP},
	}
	configure(&cfg)
	NewHandler(cfg).Mount(r)
	return r
}

func post(r *gin.Engine, path string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return body.Error
}

func signInBody(email, password string) map[string]any {
	return map[string]any{"email": email, "password": password, "platform": "ios", "code_challenge": testChallenge}
}

func TestSignInReturnsTheAuthorizationCode(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "Ann@Example.com", true))
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes()

	w := post(newTestHandler(f, nil), "/v1/auth/sign-in", signInBody(" ann@example.com ", "pw"))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), `"code":"the-code"`) {
		t.Fatalf("body %s", w.Body)
	}

	search := f.called("POST", "/v2/users")[0].body
	queries, _ := json.Marshal(search["queries"])
	if !strings.Contains(string(queries), `"organizationId":"org-tesserix"`) || !strings.Contains(string(queries), `"emailAddress":"ann@example.com"`) {
		t.Fatalf("search must be scoped to Kora's org by the normalised email, got %s", queries)
	}
	// The session names the user Zitadel found, never one the caller chose.
	checks, _ := json.Marshal(f.called("POST", "/v2/sessions")[0].body)
	if !strings.Contains(string(checks), `"userId":"u-1"`) || !strings.Contains(string(checks), `"password":"pw"`) {
		t.Fatalf("session checks %s", checks)
	}
	authz := f.called("GET", "/oauth/v2/authorize")[0]
	if got := authz.header.Get("x-zitadel-login-client"); got != testClient {
		t.Fatalf("x-zitadel-login-client = %q", got)
	}
	for k, want := range map[string]string{
		"client_id":             "client-ios",
		"redirect_uri":          RedirectURI,
		"code_challenge":        testChallenge,
		"code_challenge_method": "S256",
		"scope":                 "openid profile email offline_access urn:zitadel:iam:org:project:id:proj-kora:aud",
	} {
		if got := authz.query.Get(k); got != want {
			t.Fatalf("authorize %s = %q, want %q", k, got, want)
		}
	}
	fin := f.called("POST", "/v2/oidc/auth_requests/V2_42")[0].body
	if s := fin["session"].(map[string]any); s["sessionId"] != "s-1" || s["sessionToken"] != "st-1" {
		t.Fatalf("finalize session %v", s)
	}
}

func TestSignInAnswersUnknownEmailAndWrongPasswordIdentically(t *testing.T) {
	unknown := newFake(t)
	unknown.users()
	wUnknown := post(newTestHandler(unknown, nil), "/v1/auth/sign-in", signInBody("who@example.com", "pw"))

	wrong := newFake(t)
	wrong.users(human("u-1", "ann@example.com", true))
	wrong.on("POST /v2/sessions", 400, map[string]any{"code": 3, "details": []any{map[string]any{"id": "COMMAND-3M0fs"}}})
	wWrong := post(newTestHandler(wrong, nil), "/v1/auth/sign-in", signInBody("ann@example.com", "nope"))

	if wUnknown.Code != http.StatusUnauthorized || wWrong.Code != http.StatusUnauthorized {
		t.Fatalf("statuses %d / %d", wUnknown.Code, wWrong.Code)
	}
	if wUnknown.Body.String() != wWrong.Body.String() {
		t.Fatalf("bodies differ:\n%s\n%s", wUnknown.Body, wWrong.Body)
	}
	if len(wrong.called("GET", "/oauth/v2/authorize")) != 0 {
		t.Fatal("a failed password must not open an auth request")
	}
}

func TestSignInWithUnverifiedEmailResendsTheCodeOnlyAfterThePassword(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", false))
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.on("POST /v2/users/u-1/email/resend", 200, map[string]any{})

	w := post(newTestHandler(f, nil), "/v1/auth/sign-in", signInBody("ann@example.com", "pw"))
	if w.Code != http.StatusForbidden || errorCode(t, w) != "email_not_verified" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(f.called("POST", "/v2/users/u-1/email/resend")) != 1 {
		t.Fatal("expected a fresh code to be sent")
	}
	if len(f.called("GET", "/oauth/v2/authorize")) != 0 {
		t.Fatal("an unverified account must not receive a code")
	}
}

func TestSignInRefusesWhenASecondFactorWouldBeSkipped(t *testing.T) {
	for name, setup := range map[string]func(*fakeZitadel){
		"enrolled passkey only": func(f *fakeZitadel) {
			f.completes("AUTHENTICATION_METHOD_TYPE_PASSWORD", "AUTHENTICATION_METHOD_TYPE_PASSKEY")
		},
		"unknown method": func(f *fakeZitadel) {
			f.completes("AUTHENTICATION_METHOD_TYPE_SOMETHING_NEW")
		},
		"policy forces mfa": func(f *fakeZitadel) {
			f.completes()
			f.on("GET /v2/settings/login", 200, map[string]any{"settings": map[string]any{"forceMfa": true}})
		},
		"policy forces mfa for local users": func(f *fakeZitadel) {
			f.completes()
			f.on("GET /v2/settings/login", 200, map[string]any{"settings": map[string]any{"forceMfaLocalOnly": true}})
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.users(human("u-1", "ann@example.com", true))
			f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
			setup(f)
			w := post(newTestHandler(f, nil), "/v1/auth/sign-in", signInBody("ann@example.com", "pw"))
			if w.Code != http.StatusForbidden || errorCode(t, w) != "second_factor_required" {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if len(f.called("POST", "/v2/oidc/auth_requests/V2_42")) != 0 {
				t.Fatal("finalized despite a required second factor")
			}
		})
	}
}

func TestSignInRefusesACallbackCarryingAnotherState(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", true))
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes()
	f.on("POST /v2/oidc/auth_requests/V2_42", 200, map[string]any{"callbackUrl": RedirectURI + "?code=c&state=forged"})

	w := post(newTestHandler(f, nil), "/v1/auth/sign-in", signInBody("ann@example.com", "pw"))
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), `"code"`) {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestSignInValidatesPlatformAndChallenge(t *testing.T) {
	f := newFake(t)
	r := newTestHandler(f, nil)
	for _, body := range []map[string]any{
		{"email": "a@b.co", "password": "pw", "platform": "web", "code_challenge": testChallenge},
		{"email": "a@b.co", "password": "pw", "platform": "ios", "code_challenge": "short"},
		{"email": "not-an-email", "password": "pw", "platform": "ios", "code_challenge": testChallenge},
	} {
		if w := post(r, "/v1/auth/sign-in", body); w.Code != http.StatusBadRequest {
			t.Fatalf("%v: status %d", body, w.Code)
		}
	}
	if len(f.called("POST", "/v2/users")) != 0 {
		t.Fatal("invalid input reached Zitadel")
	}
}

func TestSignInIsRateLimitedPerEmailIgnoringCase(t *testing.T) {
	f := newFake(t)
	f.users()
	r := newTestHandler(f, nil)
	for i := 0; i < 10; i++ {
		if w := post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status %d", i, w.Code)
		}
	}
	if w := post(r, "/v1/auth/sign-in", signInBody("ANN@example.com", "pw")); w.Code != http.StatusTooManyRequests {
		t.Fatalf("11th attempt: status %d", w.Code)
	}
}

func TestRoutesAnswer503WithoutALoginClientToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	NewHandler(Config{}).Mount(r)
	if w := post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.Code)
	}
}

func signUpBody(email string) map[string]any {
	return map[string]any{"name": "  Ann   Lee  Smith ", "email": email, "password": "Str0ng!Password"}
}

func TestSignUpCreatesAnUnverifiedUserAndMailsACode(t *testing.T) {
	f := newFake(t)
	f.users()
	f.on("POST /v2/users/human", 200, map[string]any{"userId": "u-new"})

	w := post(newTestHandler(f, nil), "/v1/auth/sign-up", signUpBody("ann@example.com"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	body := f.called("POST", "/v2/users/human")[0].body
	raw, _ := json.Marshal(body)
	for _, want := range []string{
		`"orgId":"org-tesserix"`,
		`"sendCode":{}`,
		`"displayName":"Ann Lee Smith"`,
		`"givenName":"Ann"`,
		`"familyName":"Lee Smith"`,
		`"changeRequired":false`,
	} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("create body missing %s: %s", want, raw)
		}
	}
	if strings.Contains(string(raw), "isVerified") {
		t.Fatalf("a password sign-up must not be created verified: %s", raw)
	}
}

func TestSignUpRefusesAVerifiedEmail(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", true))
	d := &recordingDeleter{}

	w := post(newTestHandler(f, d), "/v1/auth/sign-up", signUpBody("ann@example.com"))
	if w.Code != http.StatusConflict || errorCode(t, w) != "email_taken" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(d.deleted) != 0 || len(f.called("POST", "/v2/users/human")) != 0 {
		t.Fatal("a verified account must never be touched")
	}
}

func TestSignUpReplacesAnUnverifiedAccount(t *testing.T) {
	f := newFake(t)
	f.users(human("u-old", "ann@example.com", false))
	f.on("POST /v2/users/human", 200, map[string]any{"userId": "u-new"})
	d := &recordingDeleter{}

	w := post(newTestHandler(f, d), "/v1/auth/sign-up", signUpBody("ann@example.com"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(d.deleted) != 1 || d.deleted[0] != "u-old" {
		t.Fatalf("deleted %v", d.deleted)
	}
}

func TestSignUpReportsAWeakPassword(t *testing.T) {
	f := newFake(t)
	f.users()
	f.on("POST /v2/users/human", 400, map[string]any{"code": 3, "details": []any{map[string]any{"id": weakPasswordErrorID}}})

	w := post(newTestHandler(f, nil), "/v1/auth/sign-up", signUpBody("ann@example.com"))
	if w.Code != http.StatusUnprocessableEntity || errorCode(t, w) != "weak_password" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestVerifyEmailMapsAWrongCode(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", false))
	f.on("POST /v2/users/u-1/email/verify", 400, map[string]any{"code": 3, "details": []any{map[string]any{"id": "COMMAND-eis9R"}}})

	w := post(newTestHandler(f, nil), "/v1/auth/verify-email", map[string]any{"email": "ann@example.com", "code": " abc123 "})
	if w.Code != http.StatusBadRequest || errorCode(t, w) != "invalid_code" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got := f.called("POST", "/v2/users/u-1/email/verify")[0].body["verificationCode"]; got != "ABC123" {
		t.Fatalf("code sent as %v", got)
	}
}

func TestMailRoutesAnswer202WhetherOrNotTheAccountExists(t *testing.T) {
	for _, path := range []string{"/v1/auth/resend-code", "/v1/auth/password-reset"} {
		exists := newFake(t)
		exists.users(human("u-1", "ann@example.com", false))
		exists.on("POST /v2/users/u-1/email/resend", 200, map[string]any{})
		exists.on("POST /v2/users/u-1/password_reset", 200, map[string]any{})
		missing := newFake(t)
		missing.users()

		a := post(newTestHandler(exists, nil), path, map[string]any{"email": "ann@example.com"})
		b := post(newTestHandler(missing, nil), path, map[string]any{"email": "who@example.com"})
		if a.Code != http.StatusAccepted || b.Code != http.StatusAccepted || a.Body.String() != b.Body.String() {
			t.Fatalf("%s: %d %s / %d %s", path, a.Code, a.Body, b.Code, b.Body)
		}
	}
}

func TestPasswordResetConfirmSetsThePasswordWithTheCode(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", true))
	f.on("POST /v2/users/u-1/password", 200, map[string]any{})

	w := post(newTestHandler(f, nil), "/v1/auth/password-reset/confirm",
		map[string]any{"email": "ann@example.com", "code": "xyz789", "password": "N3w!Password!"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	body := f.called("POST", "/v2/users/u-1/password")[0].body
	if body["verificationCode"] != "XYZ789" {
		t.Fatalf("body %v", body)
	}
}

func TestIDPStartUsesTheFixedCallbackURL(t *testing.T) {
	f := newFake(t)
	f.on("POST /v2/idp_intents", 200, map[string]any{"authUrl": "https://accounts.google.com/o/oauth2/auth?x=1"})

	w := post(newTestHandler(f, nil), "/v1/auth/idp/start",
		map[string]any{"provider": "google", "success_url": "https://evil.example.com"})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "accounts.google.com") {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	body := f.called("POST", "/v2/idp_intents")[0].body
	urls := body["urls"].(map[string]any)
	if body["idpId"] != testGoogleIDP || urls["successUrl"] != IDPCallbackURL || urls["failureUrl"] != IDPCallbackURL {
		t.Fatalf("intent body %v", body)
	}
}

func intentBody(provider string) map[string]any {
	return map[string]any{
		"provider": provider, "intent_id": "i-1", "intent_token": "it-1",
		"platform": "android", "code_challenge": testChallenge,
	}
}

func (f *fakeZitadel) intent(idpID, linkedUser, email string, verified any) {
	raw := map[string]any{"email": email, "given_name": "Ann"}
	if verified != nil {
		raw["email_verified"] = verified
	}
	if idpID == testGoogleIDP {
		raw = map[string]any{"User": raw} // Zitadel's real Google shape
	}
	f.on("POST /v2/idp_intents/i-1", 200, map[string]any{
		"userId": linkedUser,
		"idpInformation": map[string]any{
			"idpId": idpID, "userId": "ext-1", "userName": email, "rawInformation": raw,
		},
	})
}

func TestIDPFinishSignsInALinkedIdentity(t *testing.T) {
	f := newFake(t)
	f.intent(testAppleIDP, "u-1", "ann@privaterelay.appleid.com", "true")
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes("AUTHENTICATION_METHOD_TYPE_IDP")

	w := post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("apple"))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "the-code") {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	checks, _ := json.Marshal(f.called("POST", "/v2/sessions")[0].body)
	if !strings.Contains(string(checks), `"userId":"u-1"`) || !strings.Contains(string(checks), `"idpIntentToken":"it-1"`) {
		t.Fatalf("session checks %s", checks)
	}
	if got := f.called("GET", "/oauth/v2/authorize")[0].query.Get("client_id"); got != "client-android" {
		t.Fatalf("client_id %q", got)
	}
}

func TestIDPFinishRefusesAnIntentFromAnotherIDP(t *testing.T) {
	f := newFake(t)
	f.intent(testAppleIDP, "u-1", "ann@example.com", true)

	w := post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("google"))
	if w.Code != http.StatusBadRequest || errorCode(t, w) != "invalid_intent" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(f.called("POST", "/v2/sessions")) != 0 {
		t.Fatal("opened a session from a mismatched intent")
	}
}

func TestIDPFinishRefusesToProvisionOnAnUnverifiedEmail(t *testing.T) {
	for name, verified := range map[string]any{"false": false, "absent": nil, "odd string": "TRUE"} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.intent(testGoogleIDP, "", "ann@example.com", verified)
			w := post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("google"))
			if w.Code != http.StatusForbidden || errorCode(t, w) != "email_not_verified" {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if len(f.called("POST", "/v2/users")) != 0 {
				t.Fatal("looked up accounts for an unverified email")
			}
		})
	}
}

func TestIDPFinishLinksAnExistingVerifiedAccount(t *testing.T) {
	f := newFake(t)
	f.intent(testGoogleIDP, "", "ann@example.com", true)
	f.users(human("u-1", "ann@example.com", true))
	f.on("POST /v2/users/u-1/links", 200, map[string]any{})
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes("AUTHENTICATION_METHOD_TYPE_PASSWORD", "AUTHENTICATION_METHOD_TYPE_IDP")

	w := post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("google"))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	link := f.called("POST", "/v2/users/u-1/links")[0].body["idpLink"].(map[string]any)
	if link["idpId"] != testGoogleIDP || link["userId"] != "ext-1" {
		t.Fatalf("link %v", link)
	}
	if len(f.called("POST", "/v2/users/human")) != 0 {
		t.Fatal("created a second account beside an existing one")
	}
}

func TestIDPFinishCreatesAVerifiedLinkedAccountOnFirstUse(t *testing.T) {
	f := newFake(t)
	f.intent(testGoogleIDP, "", "ann@example.com", true)
	f.users()
	f.on("POST /v2/users/human", 200, map[string]any{"userId": "u-1"})
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes("AUTHENTICATION_METHOD_TYPE_IDP")

	w := post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("google"))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	raw, _ := json.Marshal(f.called("POST", "/v2/users/human")[0].body)
	for _, want := range []string{`"isVerified":true`, `"idpId":"idp-google"`, `"userId":"ext-1"`, `"orgId":"org-tesserix"`, `"givenName":"Ann"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("create body missing %s: %s", want, raw)
		}
	}
}

func TestLogPathDropsIDs(t *testing.T) {
	for in, want := range map[string]string{
		"/v2/users/394892763469972021/email/verify":       "/v2/users/{id}/email/verify",
		"/v2/oidc/auth_requests/V2_395075145196110389":    "/v2/oidc/auth_requests/{id}",
		"/v2/settings/login?ctx.orgId=386377229942128837": "/v2/settings/login",
	} {
		if got := logPath(in); got != want {
			t.Fatalf("logPath(%q) = %q, want %q", in, got, want)
		}
	}
}
