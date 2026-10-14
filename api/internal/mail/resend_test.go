package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewResendWithoutAKeyIsNil(t *testing.T) {
	if NewResend("", "Kora <no-reply@tesserix.app>") != nil {
		t.Fatal("an empty key must give no mailer")
	}
}

func TestResendSendsOneMessage(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"e-1"}`))
	}))
	defer srv.Close()
	r := NewResend("re_key", "Kora <no-reply@tesserix.app>")
	r.url = srv.URL

	err := r.Send(context.Background(), Message{To: "ann@example.com", Subject: "s", Text: "t", HTML: "<p>h</p>"})
	if err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer re_key" {
		t.Fatalf("auth %q", auth)
	}
	to, _ := got["to"].([]any)
	if got["from"] != "Kora <no-reply@tesserix.app>" || len(to) != 1 || to[0] != "ann@example.com" ||
		got["subject"] != "s" || got["text"] != "t" || got["html"] != "<p>h</p>" {
		t.Fatalf("body %v", got)
	}
}

func TestResendReportsARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"name":"validation_error","message":"The tesserix.app domain is not verified."}`))
	}))
	defer srv.Close()
	r := NewResend("re_key", "Kora <no-reply@tesserix.app>")
	r.url = srv.URL

	err := r.Send(context.Background(), Message{To: "ann@example.com"})
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "not verified") {
		t.Fatalf("err %v", err)
	}
}
