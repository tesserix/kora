package auth

import (
	"context"
	"encoding/json"
	"errors"
	fbauth "firebase.google.com/go/v4/auth"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSelfAccountStatusRejectsRevokedDisabledAndInvalidResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		valid      bool
	}{
		{"active", `{"users":[{"localId":"u1","validSince":"100"}]}`, 200, true},
		{"disabled", `{"users":[{"localId":"u1","validSince":"100","disabled":true}]}`, 200, false},
		{"revoked_before_latest_token_issuance", `{"users":[{"localId":"u1","validSince":"101"}]}`, 200, false},
		{"different_user", `{"users":[{"localId":"u2","validSince":"100"}]}`, 200, false},
		{"missing_boundary", `{"users":[{"localId":"u1"}]}`, 200, false},
		{"negative_boundary", `{"users":[{"localId":"u1","validSince":"-1"}]}`, 200, false},
		{"malformed_boundary", `{"users":[{"localId":"u1","validSince":"not-a-time"}]}`, 200, false},
		{"missing_user", `{"users":[]}`, 200, false},
		{"multiple_users", `{"users":[{"localId":"u1","validSince":"100"},{"localId":"u2","validSince":"100"}]}`, 200, false},
		{"malformed_json", `{`, 200, false},
		{"error_response", `{"error":"synthetic-id-token synthetic-key"}`, 400, false},
		{"unavailable", `{"error":"synthetic-id-token synthetic-key"}`, 503, false},
		{"oversized", strings.Repeat(" ", 1<<20) + `{"users":[{"localId":"u1","validSince":"100"}]}`, 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, http.MethodPost, r.Method)
				require.Equal(t, "synthetic-key", r.URL.Query().Get("key"))
				var input map[string]string
				require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
				require.Equal(t, map[string]string{"idToken": "synthetic-id-token"}, input)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			checker := accountStatusClient{apiKey: "synthetic-key", endpoint: server.URL, http: server.Client()}
			err := checker.check(t.Context(), "synthetic-id-token", &fbauth.Token{UID: "u1", AuthTime: 100, IssuedAt: 200})
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "synthetic-id-token")
				require.NotContains(t, err.Error(), "synthetic-key")
			}
		})
	}
}

func TestSelfAccountStatusRejectsMissingAuthTimeAndCancellation(t *testing.T) {
	c := accountStatusClient{apiKey: "synthetic-key", endpoint: "http://127.0.0.1:1", http: &http.Client{}}
	require.Error(t, c.check(t.Context(), "synthetic-id-token", &fbauth.Token{UID: "u1"}))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.Error(t, c.check(ctx, "synthetic-id-token", &fbauth.Token{UID: "u1", AuthTime: 100}))
}

type firebaseTokenStub struct {
	token                   *fbauth.Token
	err                     error
	publicCalls, adminCalls int
}

func (c *firebaseTokenStub) VerifyIDToken(context.Context, string) (*fbauth.Token, error) {
	c.publicCalls++
	return c.token, c.err
}
func (c *firebaseTokenStub) VerifyIDTokenAndCheckRevoked(context.Context, string) (*fbauth.Token, error) {
	c.adminCalls++
	return c.token, c.err
}
func (c *firebaseTokenStub) DeleteUser(context.Context, string) error { return nil }

func TestVerifierChecksSignatureBeforeAccountStatusAndNeverFallsBack(t *testing.T) {
	for _, tc := range []struct {
		name            string
		signatureError  bool
		status          int
		wantStatusCalls int
		wantError       bool
	}{
		{"valid", false, 200, 1, false},
		{"invalid_signature", true, 200, 0, true},
		{"lookup_unavailable", false, 503, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"users":[{"localId":"u1","validSince":"100"}]}`))
			}))
			defer server.Close()
			sdk := &firebaseTokenStub{token: &fbauth.Token{UID: "u1", AuthTime: 100}}
			if tc.signatureError {
				sdk.err = errors.New("invalid signature")
			}
			v := firebaseVerifier{client: sdk, accountStatus: &accountStatusClient{apiKey: "synthetic-key", endpoint: server.URL, http: server.Client()}}
			claims, err := v.Verify(t.Context(), "synthetic-token")
			if tc.wantError {
				require.Error(t, err)
				require.Empty(t, claims.UID)
			} else {
				require.NoError(t, err)
				require.Equal(t, "u1", claims.UID)
			}
			require.EqualValues(t, tc.wantStatusCalls, calls.Load())
			require.Equal(t, 1, sdk.publicCalls)
			require.Zero(t, sdk.adminCalls)
		})
	}
	sdk := &firebaseTokenStub{token: &fbauth.Token{UID: "u1", AuthTime: 100}}
	_, err := (firebaseVerifier{client: sdk}).Verify(t.Context(), "synthetic-token")
	require.NoError(t, err)
	require.Equal(t, 1, sdk.adminCalls)
	require.Zero(t, sdk.publicCalls)
}

func TestAccountStatusNeverForwardsTokenAcrossRedirects(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	checker := newAccountStatusClient("synthetic-key")
	checker.endpoint = source.URL
	require.Error(t, checker.check(t.Context(), "synthetic-token", &fbauth.Token{UID: "u1", AuthTime: 100}))
	require.Zero(t, redirected.Load())
}
