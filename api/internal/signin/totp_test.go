package signin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// totpUser is a verified password user with an authenticator app enrolled,
// whose session check accepts only 123456.
func totpUser(t *testing.T) *fakeZitadel {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", true))
	f.on("POST /v2/sessions", 200, map[string]any{"sessionId": "s-1", "sessionToken": "st-1"})
	f.completes("AUTHENTICATION_METHOD_TYPE_PASSWORD", "AUTHENTICATION_METHOD_TYPE_TOTP")
	f.handle("PATCH /v2/sessions/s-1", func(c call) (int, any) {
		code, _ := c.body["checks"].(map[string]any)["totp"].(map[string]any)["code"].(string)
		if c.body["sessionToken"] != "st-1" || code != "123456" {
			return 400, map[string]any{"code": 3, "details": []any{map[string]any{"id": "COMMAND-8isk2"}}}
		}
		return 200, map[string]any{"sessionToken": "st-2"}
	})
	return f
}

func challengeFrom(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error     string `json:"error"`
		Challenge string `json:"challenge"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusForbidden || body.Error != "totp_required" || body.Challenge == "" {
		t.Fatalf("want a totp challenge, got %d: %s", w.Code, w.Body)
	}
	return body.Challenge
}

func totpBody(challenge, code string) map[string]any {
	return map[string]any{"challenge": challenge, "code": code}
}

func TestSignInWithAnAuthenticatorAppNeedsItsCode(t *testing.T) {
	f := totpUser(t)
	r := newTestHandler(f, nil)

	challenge := challengeFrom(t, post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")))
	if len(f.called("POST", "/v2/oidc/auth_requests/V2_42")) != 0 {
		t.Fatal("finalized before the second factor")
	}

	w := post(r, "/v1/auth/totp", totpBody(challenge, " 123 456 "))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"code":"the-code"`) {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	// Finalized with the token the TOTP check returned, not the password's.
	fin := f.called("POST", "/v2/oidc/auth_requests/V2_42")[0].body["session"].(map[string]any)
	if fin["sessionToken"] != "st-2" {
		t.Fatalf("finalized with %v", fin["sessionToken"])
	}
	// A challenge finishes one sign-in only.
	if w := post(r, "/v1/auth/totp", totpBody(challenge, "123456")); errorCode(t, w) != "challenge_expired" {
		t.Fatalf("reused challenge: %d %s", w.Code, w.Body)
	}
}

func TestFederatedSignInWithAnAuthenticatorAppNeedsItsCodeToo(t *testing.T) {
	f := totpUser(t)
	f.intent(testGoogleIDP, "u-1", "ann@example.com", true)
	f.completes("AUTHENTICATION_METHOD_TYPE_IDP", "AUTHENTICATION_METHOD_TYPE_TOTP")

	challengeFrom(t, post(newTestHandler(f, nil), "/v1/auth/idp/finish", intentBody("google")))
}

func TestAWrongAuthenticatorCodeCanBeRetriedUntilTheLimit(t *testing.T) {
	f := totpUser(t)
	r := newTestHandler(f, nil)
	challenge := challengeFrom(t, post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")))

	for i := 1; i < totpAttempts; i++ {
		if w := post(r, "/v1/auth/totp", totpBody(challenge, "000000")); errorCode(t, w) != "invalid_code" {
			t.Fatalf("miss %d: %d %s", i, w.Code, w.Body)
		}
	}
	if w := post(r, "/v1/auth/totp", totpBody(challenge, "000000")); errorCode(t, w) != "challenge_expired" {
		t.Fatalf("last miss: %d %s", w.Code, w.Body)
	}
	// Gone even for the right code: the password has to be proven again.
	if w := post(r, "/v1/auth/totp", totpBody(challenge, "123456")); errorCode(t, w) != "challenge_expired" {
		t.Fatalf("after the limit: %d %s", w.Code, w.Body)
	}
	if len(f.called("POST", "/v2/oidc/auth_requests/V2_42")) != 0 {
		t.Fatal("finalized without a good code")
	}
}

func TestAnAuthenticatorCodeIsCheckedForShapeBeforeZitadel(t *testing.T) {
	f := totpUser(t)
	r := newTestHandler(f, nil)
	challenge := challengeFrom(t, post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")))

	for _, code := range []string{"", "12345", "1234567", "12a456"} {
		if w := post(r, "/v1/auth/totp", totpBody(challenge, code)); errorCode(t, w) != "invalid_input" {
			t.Fatalf("%q: %d %s", code, w.Code, w.Body)
		}
	}
	if len(f.called("PATCH", "/v2/sessions/s-1")) != 0 {
		t.Fatal("a malformed code reached Zitadel")
	}
	// Malformed input spends no attempt.
	if w := post(r, "/v1/auth/totp", totpBody(challenge, "123456")); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestAnUnknownChallengeIsExpired(t *testing.T) {
	w := post(newTestHandler(totpUser(t), nil), "/v1/auth/totp", totpBody("made-up", "123456"))
	if errorCode(t, w) != "challenge_expired" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestAChallengeExpiresAfterItsWindow(t *testing.T) {
	ch := newTOTPChallenges()
	now := time.Now()
	id, err := ch.open(pendingTOTP{userID: "u-1"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ch.take(id, now.Add(totpWindow+time.Second)); ok {
		t.Fatal("an expired challenge was accepted")
	}
}

func TestAZitadelOutageSpendsNoAttempt(t *testing.T) {
	f := totpUser(t)
	gin.SetMode(gin.TestMode)
	r := newTestHandler(f, nil)
	challenge := challengeFrom(t, post(r, "/v1/auth/sign-in", signInBody("ann@example.com", "pw")))
	f.on("PATCH /v2/sessions/s-1", 503, map[string]any{})

	for i := 0; i < totpAttempts+1; i++ {
		if w := post(r, "/v1/auth/totp", totpBody(challenge, "123456")); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("attempt %d: %d %s", i, w.Code, w.Body)
		}
	}
	totpUserAccepts(f)
	if w := post(r, "/v1/auth/totp", totpBody(challenge, "123456")); w.Code != http.StatusOK {
		t.Fatalf("after the outage: %d %s", w.Code, w.Body)
	}
}

func totpUserAccepts(f *fakeZitadel) {
	f.on("PATCH /v2/sessions/s-1", 200, map[string]any{"sessionToken": "st-2"})
}
