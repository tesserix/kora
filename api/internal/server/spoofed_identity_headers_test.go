package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/user"
)

// errUnknownToken is keyedVerifier's failure for a token it was never handed
// a claim for -- exercised by nothing here directly, but keeps Verify's
// contract honest (a verifier that "accepts" an unrecognized token would
// defeat the whole point of this file).
var errUnknownToken = errors.New("unknown bearer token")

// keyedVerifier maps a bearer token to the Firebase claims it was legitimately
// issued for. Unlike stubVerifier (router_test.go), which answers every token
// identically, this lets the test hand out a real, distinguishable identity
// for "user A" and prove that identity -- not anything an attacker put in a
// header -- is what reaches the gateway.
type keyedVerifier map[string]auth.Claims

func (v keyedVerifier) Verify(_ context.Context, idToken string) (auth.Claims, error) {
	claims, ok := v[idToken]
	if !ok {
		return auth.Claims{}, errUnknownToken
	}
	return claims, nil
}

// bodyCompositionMultipart builds a minimal multipart/form-data body carrying
// a "file" part. The bytes need not be a real image: downscaleForProvider
// (internal/bodyread/downscale.go) returns undecodable input unchanged rather
// than erroring, so garbage bytes reach the provider exactly like a real
// screenshot would.
func bodyCompositionMultipart(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", "scale.png")
	require.NoError(t, err)
	_, err = part.Write([]byte("not a real image, but downscaleForProvider tolerates that"))
	require.NoError(t, err)
	require.NoError(t, w.Close())
	return &buf, w.FormDataContentType()
}

// bodyCompositionGatewayReply is a well-formed chat-completion response
// shaped the way AgentGatewayProvider.IdentifyBodyComposition expects to
// parse it (mirrors the "identify body composition" case in
// agentgateway_test.go). Content genuinely doesn't matter here -- this file
// is about which HEADERS reach the gateway, not what it answers -- but the
// response has to parse cleanly for the request to complete instead of
// erroring out before the assertions run.
const bodyCompositionGatewayReply = `{"weight_kg":72.4,"body_fat_pct":null,"subcutaneous_fat_pct":null,"visceral_fat_rating":null,"skeletal_muscle_pct":null,"muscle_mass_kg":null,"body_water_pct":null,"protein_pct":null,"bone_mass_kg":null,"scale_bmr_kcal":null,"reading_date":null}`

// newCapturingGateway stands in for the real Agent Gateway. It records every
// inbound request's headers into *captured and answers with a valid
// body-composition reading, so the router's real handler chain completes
// instead of erroring out on a malformed upstream response.
func newCapturingGateway(t *testing.T, captured *http.Header) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*captured = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "completion-1", "object": "chat.completion",
			"choices": []map[string]any{{
				"index":         0,
				"message":       map[string]any{"role": "assistant", "content": bodyCompositionGatewayReply},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

// ensureTestUser provisions (or reuses) a users row for firebaseUID, exactly
// as user.ResolveMiddleware's real EnsureUser call would on a genuine sign-in,
// and registers cleanup. It exists so this file's tests can assert on the
// REAL, DB-resolved UUID for "user A" -- not a value the test invented -- as
// the one true source the gateway should ever see.
func ensureTestUser(t *testing.T, db *gorm.DB, repo user.Repository, firebaseUID string) uuid.UUID {
	t.Helper()
	u, err := repo.EnsureUser(context.Background(), firebaseUID, firebaseUID+"@test.dev", "")
	require.NoError(t, err)
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE firebase_uid = ?", firebaseUID)
	})
	return u.ID
}

// TestSpoofedIdentityHeadersAreIgnoredForAnAuthenticatedUser is the negative
// test kora#252's triage named as the sharpest remaining gap: nothing
// previously asserted that a client-supplied X-Kora-User-Id or
// X-Kora-End-User-Token is powerless against the gateway. Without this test,
// a plausible future refactor -- "helpfully" forwarding inbound headers onto
// the outbound AgentGateway call -- would let any authenticated caller
// attribute their AI spend to an arbitrary other user, or hand the gateway a
// forged end-user credential, and no test would go red.
//
// This drives a request through the REAL router (auth.Middleware ->
// user.ResolveMiddleware -> bodyread.Handler.Read -> AgentGatewayProvider),
// exactly as production wires it in NewRouter, against a real Postgres
// connection -- not a hand-built context.Context like agentgateway_test.go
// uses, because the property under test IS that inbound HTTP headers can't
// reach that context in the first place. User A authenticates legitimately;
// the request ALSO carries X-Kora-User-Id and X-Kora-End-User-Token naming a
// different user entirely. The gateway must see only A's real, DB-resolved
// UUID and A's real verified bearer token.
func TestSpoofedIdentityHeadersAreIgnoredForAnAuthenticatedUser(t *testing.T) {
	db := testDB(t)
	repo := user.NewRepository(db)

	const legitToken = "user-a-genuine-firebase-token"
	firebaseUID := "spoof-test-a-" + uuid.NewString()
	userAID := ensureTestUser(t, db, repo, firebaseUID)

	verifier := keyedVerifier{legitToken: auth.Claims{UID: firebaseUID, Email: firebaseUID + "@test.dev"}}

	var captured http.Header
	gateway := newCapturingGateway(t, &captured)
	provider := providers.NewAgentGatewayProvider("gateway-key", gateway.URL+"/v1", "kora-auto")

	r := NewRouter(Deps{DB: db, Verifier: verifier, Provider: provider})

	body, contentType := bodyCompositionMultipart(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+legitToken)

	// The attack: headers an inbound client fully controls, naming a
	// DIFFERENT identity than the one the Authorization token authenticates.
	attackerUserID := uuid.New()
	req.Header.Set("X-Kora-User-Id", attackerUserID.String())
	req.Header.Set("X-Kora-End-User-Token", "Bearer forged-token-for-someone-else")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.NotEmpty(t, captured, "request never reached the gateway -- nothing to assert on")

	assert.Equal(t, userAID.String(), captured.Get("X-Kora-User-Id"),
		"gateway must see user A's real resolved id, never the attacker-supplied one")
	assert.NotEqual(t, attackerUserID.String(), captured.Get("X-Kora-User-Id"))

	assert.Equal(t, "Bearer "+legitToken, captured.Get("X-Kora-End-User-Token"),
		"gateway must see the caller's own verified token, never a forged one carried in a header")
	assert.NotEqual(t, "Bearer forged-token-for-someone-else", captured.Get("X-Kora-End-User-Token"))
}

// TestSpoofedUserIDHeaderProducesNoHeaderWhenUnauthenticated is the
// absence-can't-be-spoofed half of kora#252: cmd/embed's backfill relies on
// "no X-Kora-User-Id header" meaning "genuinely no user", never "attacker set
// one and it got dropped to empty" or, worse, "attacker set one and it went
// through". This drives a request with NO Authorization header at all -- so
// it never reaches user.ResolveMiddleware, exactly like an unauthenticated
// caller or a non-HTTP context such as cmd/embed's context.Background() --
// while still carrying a forged X-Kora-User-Id. The route must 401 before
// ever touching the gateway, and the property this pins is that there is no
// code path, anywhere in the chain, that would have copied that header
// through even if one existed.
func TestSpoofedUserIDHeaderProducesNoHeaderWhenUnauthenticated(t *testing.T) {
	db := testDB(t)

	var captured http.Header
	gateway := newCapturingGateway(t, &captured)
	provider := providers.NewAgentGatewayProvider("gateway-key", gateway.URL+"/v1", "kora-auto")

	r := NewRouter(Deps{DB: db, Verifier: keyedVerifier{}, Provider: provider})

	body, contentType := bodyCompositionMultipart(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	// Deliberately no Authorization header: this is the unauthenticated case.
	req.Header.Set("X-Kora-User-Id", uuid.New().String())

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Empty(t, captured, "an unauthenticated request must never reach the gateway at all")
}
