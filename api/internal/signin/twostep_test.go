package signin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// accountRouter mounts the two-step routes behind a stand-in for
// auth.Middleware that signs every request in as uid.
func accountRouter(f *fakeZitadel, uid string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(Config{Issuer: f.srv.URL, ProjectID: "proj-kora", Token: "pat"})
	g := r.Group("/v1", func(c *gin.Context) {
		if uid != "" {
			c.Set("uid", uid)
		}
	})
	h.MountAccount(g)
	return r
}

func send(r *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func methods(f *fakeZitadel, ms ...string) {
	f.on("GET /v2/users/u-1/authentication_methods", 200, map[string]any{"authMethodTypes": ms})
}

func TestTwoStepStatusReadsTheCallersOwnMethods(t *testing.T) {
	f := newFake(t)
	methods(f, "AUTHENTICATION_METHOD_TYPE_PASSWORD", "AUTHENTICATION_METHOD_TYPE_TOTP")

	w := send(accountRouter(f, "u-1"), http.MethodGet, "/v1/me/two-step", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":true`) {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestTwoStepNeedsASignedInCaller(t *testing.T) {
	w := send(accountRouter(newFake(t), ""), http.MethodGet, "/v1/me/two-step", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

func TestTwoStepSetupThenConfirm(t *testing.T) {
	f := newFake(t)
	methods(f, "AUTHENTICATION_METHOD_TYPE_PASSWORD")
	f.on("POST /v2/users/u-1/totp", 200, map[string]any{"uri": "otpauth://totp/Tesserix:ann?secret=ABC", "secret": "ABC"})
	f.handle("POST /v2/users/u-1/totp/verify", func(c call) (int, any) {
		if c.body["code"] != "123456" {
			return 400, map[string]any{"code": 3}
		}
		return 200, map[string]any{}
	})
	r := accountRouter(f, "u-1")

	w := send(r, http.MethodPost, "/v1/me/two-step/setup", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"secret":"ABC"`) || !strings.Contains(w.Body.String(), "otpauth://") {
		t.Fatalf("setup %d: %s", w.Code, w.Body)
	}
	if w := send(r, http.MethodPost, "/v1/me/two-step/confirm", map[string]any{"code": "000000"}); errorCode(t, w) != "invalid_code" {
		t.Fatalf("wrong code %d: %s", w.Code, w.Body)
	}
	if w := send(r, http.MethodPost, "/v1/me/two-step/confirm", map[string]any{"code": "123 456"}); w.Code != http.StatusOK {
		t.Fatalf("confirm %d: %s", w.Code, w.Body)
	}
}

func TestTwoStepSetupRefusesWhenAlreadyOn(t *testing.T) {
	f := newFake(t)
	methods(f, "AUTHENTICATION_METHOD_TYPE_PASSWORD", "AUTHENTICATION_METHOD_TYPE_TOTP")

	w := send(accountRouter(f, "u-1"), http.MethodPost, "/v1/me/two-step/setup", nil)
	if w.Code != http.StatusConflict || errorCode(t, w) != "already_enabled" {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(f.called("POST", "/v2/users/u-1/totp")) != 0 {
		t.Fatal("re-registered an enrolled authenticator")
	}
}

func TestTwoStepDisableNeedsACurrentCode(t *testing.T) {
	f := newFake(t)
	f.handle("POST /v2/sessions", func(c call) (int, any) {
		raw, _ := json.Marshal(c.body)
		if !strings.Contains(string(raw), `"userId":"u-1"`) || !strings.Contains(string(raw), `"code":"123456"`) {
			return 400, map[string]any{"code": 3}
		}
		return 200, map[string]any{"sessionId": "s-9", "sessionToken": "st-9"}
	})
	f.on("DELETE /v2/sessions/s-9", 200, map[string]any{})
	f.on("DELETE /v2/users/u-1/totp", 200, map[string]any{})
	r := accountRouter(f, "u-1")

	if w := send(r, http.MethodPost, "/v1/me/two-step/disable", map[string]any{"code": "000000"}); errorCode(t, w) != "invalid_code" {
		t.Fatalf("wrong code %d: %s", w.Code, w.Body)
	}
	if len(f.called("DELETE", "/v2/users/u-1/totp")) != 0 {
		t.Fatal("removed on a wrong code")
	}
	w := send(r, http.MethodPost, "/v1/me/two-step/disable", map[string]any{"code": "123456"})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatalf("disable %d: %s", w.Code, w.Body)
	}
	if len(f.called("DELETE", "/v2/users/u-1/totp")) != 1 {
		t.Fatal("not removed")
	}
	// The proof session is ended, not left open.
	if got := f.called("DELETE", "/v2/sessions/s-9"); len(got) != 1 || got[0].body["sessionToken"] != "st-9" {
		t.Fatalf("proof session not ended: %v", got)
	}
}

func TestTwoStepCodesAreRateLimitedPerPerson(t *testing.T) {
	f := newFake(t)
	f.on("POST /v2/users/u-1/totp/verify", 400, map[string]any{"code": 3})
	r := accountRouter(f, "u-1")

	var last *httptest.ResponseRecorder
	for i := 0; i < 11; i++ {
		last = send(r, http.MethodPost, "/v1/me/two-step/confirm", map[string]any{"code": "000000"})
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d: %s", last.Code, last.Body)
	}
}
