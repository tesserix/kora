package signin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/tesserix/kora/api/internal/mail"
)

type recordingMailer struct {
	mu   sync.Mutex
	sent []mail.Message
	err  error
}

func (m *recordingMailer) Send(_ context.Context, msg mail.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return m.err
}

func withMailer(m Mailer) func(*Config) {
	return func(c *Config) { c.Mailer = m }
}

func namedHuman(id, email, givenName string, verified bool) map[string]any {
	u := human(id, email, verified)
	u["human"].(map[string]any)["profile"] = map[string]any{"givenName": givenName}
	return u
}

func rawBody(c call) string {
	raw, _ := json.Marshal(c.body)
	return string(raw)
}

func TestSignUpWithAMailerSendsKorasOwnCodeEmail(t *testing.T) {
	f := newFake(t)
	f.users()
	f.on("POST /v2/users/human", 200, map[string]any{"userId": "u-new", "emailCode": "K7Q2XZ"})
	m := &recordingMailer{}

	w := post(newHandlerWith(f, withMailer(m)), "/v1/auth/sign-up", signUpBody("ann@example.com"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if body := rawBody(f.called("POST", "/v2/users/human")[0]); !strings.Contains(body, `"returnCode":{}`) || strings.Contains(body, "sendCode") {
		t.Fatalf("Zitadel must hand the code back, not mail it: %s", body)
	}
	if len(m.sent) != 1 {
		t.Fatalf("sent %d emails", len(m.sent))
	}
	msg := m.sent[0]
	if msg.To != "ann@example.com" || !strings.HasPrefix(msg.Subject, "K7Q2XZ ") {
		t.Fatalf("to %q subject %q", msg.To, msg.Subject)
	}
	for _, part := range []string{msg.Text, msg.HTML} {
		if !strings.Contains(part, "Hi Ann,") || !strings.Contains(part, "K7Q2XZ") || !strings.Contains(part, "confirm your email") {
			t.Fatalf("body missing greeting, code or purpose: %s", part)
		}
	}
	// The point of sending our own: nothing to click.
	if strings.Contains(msg.HTML, "<a ") || strings.Contains(msg.HTML, "href") {
		t.Fatalf("code email must carry no link: %s", msg.HTML)
	}
}

func TestPasswordResetWithAMailerGreetsByTheAccountsName(t *testing.T) {
	f := newFake(t)
	f.users(namedHuman("u-1", "ann@example.com", "Ann", true))
	f.on("POST /v2/users/u-1/password_reset", 200, map[string]any{"verificationCode": "R3SET9"})
	m := &recordingMailer{}

	w := post(newHandlerWith(f, withMailer(m)), "/v1/auth/password-reset", map[string]any{"email": "ANN@example.com"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if body := rawBody(f.called("POST", "/v2/users/u-1/password_reset")[0]); body != `{"returnCode":{}}` {
		t.Fatalf("reset body %s", body)
	}
	if len(m.sent) != 1 || !strings.Contains(m.sent[0].Subject, "password reset") || !strings.Contains(m.sent[0].Text, "Hi Ann,\n") || !strings.Contains(m.sent[0].Text, "R3SET9") {
		t.Fatalf("sent %+v", m.sent)
	}
}

func TestAFailedOwnEmailFallsBackToZitadelsMail(t *testing.T) {
	cases := []struct {
		path, zitadelPath, issued, fallback string
	}{
		{"/v1/auth/password-reset", "/v2/users/u-1/password_reset", `{"returnCode":{}}`, `"sendLink"`},
		{"/v1/auth/resend-code", "/v2/users/u-1/email/resend", `{"returnCode":{}}`, `"sendCode"`},
	}
	for _, tc := range cases {
		f := newFake(t)
		f.users(namedHuman("u-1", "ann@example.com", "Ann", false))
		f.on("POST "+tc.zitadelPath, 200, map[string]any{"verificationCode": "ABC123"})
		m := &recordingMailer{err: errors.New("resend down")}

		w := post(newHandlerWith(f, withMailer(m)), tc.path, map[string]any{"email": "ann@example.com"})
		if w.Code != http.StatusAccepted {
			t.Fatalf("%s: status %d: %s", tc.path, w.Code, w.Body)
		}
		calls := f.called("POST", tc.zitadelPath)
		if len(calls) != 2 || rawBody(calls[0]) != tc.issued || !strings.Contains(rawBody(calls[1]), tc.fallback) {
			t.Fatalf("%s: want our code then Zitadel's mail, got %d calls", tc.path, len(calls))
		}
	}
}

func TestWithoutAMailerZitadelStillMailsTheCodes(t *testing.T) {
	f := newFake(t)
	f.users(human("u-1", "ann@example.com", false))
	f.on("POST /v2/users/u-1/password_reset", 200, map[string]any{})

	post(newTestHandler(f, nil), "/v1/auth/password-reset", map[string]any{"email": "ann@example.com"})
	if body := rawBody(f.called("POST", "/v2/users/u-1/password_reset")[0]); !strings.Contains(body, `"sendLink"`) {
		t.Fatalf("reset body %s", body)
	}
}

func TestCodeEmailEscapesTheName(t *testing.T) {
	msg, err := codeEmail(verifyCode, "ann@example.com", "<b>Ann</b>", "ABC123")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(msg.HTML, "<b>Ann") || !strings.Contains(msg.HTML, "&lt;b&gt;Ann") {
		t.Fatalf("name not escaped: %s", msg.HTML)
	}
	if blank, _ := codeEmail(resetCode, "ann@example.com", " ", "ABC123"); !strings.HasPrefix(blank.Text, "Hi,\n") {
		t.Fatalf("blank name greeting: %q", blank.Text)
	}
}
