package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	testIssuer    = "https://auth.example.test"
	testProjectID = "393000000000000001"
)

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return key
}

func signToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	require.NoError(t, err)
	payload, err := json.Marshal(claims)
	require.NoError(t, err)
	obj, err := signer.Sign(payload)
	require.NoError(t, err)
	raw, err := obj.CompactSerialize()
	require.NoError(t, err)
	return raw
}

func validClaims() map[string]any {
	now := time.Now()
	return map[string]any{
		"iss":       testIssuer,
		"sub":       "394000000000000042",
		"aud":       []string{"394000000000000007", testProjectID},
		"client_id": "394000000000000007",
		"iat":       now.Unix(),
		"exp":       now.Add(10 * time.Minute).Unix(),
	}
}

func testVerifier(key *rsa.PrivateKey) zitadelVerifier {
	keys := &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{key.Public()}}
	return newZitadelVerifier(oidc.NewVerifier(testIssuer, keys, verifierConfig()), testProjectID)
}

func TestZitadelVerifierAcceptsProjectAudienceAndReturnsSubjectOnly(t *testing.T) {
	key := testKey(t)
	claims := validClaims()
	// Even if a token did carry profile claims, identity comes from sub alone;
	// profile data is userinfo's job.
	claims["email"] = "someone@example.test"

	got, err := testVerifier(key).Verify(context.Background(), signToken(t, key, claims))

	require.NoError(t, err)
	assert.Equal(t, Claims{UID: "394000000000000042"}, got)
}

func TestZitadelVerifierRejects(t *testing.T) {
	key := testKey(t)
	other := testKey(t)
	cases := map[string]struct {
		mutate func(map[string]any)
		signer *rsa.PrivateKey
		raw    string
	}{
		"another project's audience": {mutate: func(c map[string]any) { c["aud"] = []string{"394000000000000007", "999"} }},
		"wrong issuer":               {mutate: func(c map[string]any) { c["iss"] = "https://securetoken.google.com/kora-app-e6d38" }},
		"expired":                    {mutate: func(c map[string]any) { c["exp"] = time.Now().Add(-time.Minute).Unix() }},
		"empty subject":              {mutate: func(c map[string]any) { c["sub"] = "" }},
		"signed by an unknown key":   {signer: other},
		"opaque bearer token":        {raw: "fOpaqueZitadelBearerToken"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			raw := tc.raw
			if raw == "" {
				claims := validClaims()
				if tc.mutate != nil {
					tc.mutate(claims)
				}
				signer := key
				if tc.signer != nil {
					signer = tc.signer
				}
				raw = signToken(t, signer, claims)
			}

			_, err := testVerifier(key).Verify(context.Background(), raw)

			assert.Error(t, err)
		})
	}
}

func TestNewZitadelVerifierRequiresProjectID(t *testing.T) {
	_, _, err := NewZitadelVerifier(context.Background(), testIssuer, " ")
	assert.ErrorContains(t, err, "project id is required")
}

func userInfoServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer access-token", r.Header.Get("Authorization"))
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestUserInfoReturnsVerifiedEmailAndName(t *testing.T) {
	srv := userInfoServer(t, http.StatusOK, `{"sub":"1","email":"ada@example.test","email_verified":true,"name":"Ada Lovelace"}`)

	got, err := newUserInfoClient(srv.URL).Profile(context.Background(), "access-token")

	require.NoError(t, err)
	assert.Equal(t, Profile{Email: "ada@example.test", Name: "Ada Lovelace"}, got)
}

func TestUserInfoDropsUnverifiedEmail(t *testing.T) {
	srv := userInfoServer(t, http.StatusOK, `{"sub":"1","email":"victim@example.test","email_verified":false,"name":"Mallory"}`)

	got, err := newUserInfoClient(srv.URL).Profile(context.Background(), "access-token")

	require.NoError(t, err)
	assert.Equal(t, Profile{Name: "Mallory"}, got)
}

func TestUserInfoFailsOnNonOKAndBadBody(t *testing.T) {
	for name, srv := range map[string]*httptest.Server{
		"unauthorized": userInfoServer(t, http.StatusUnauthorized, `{}`),
		"not json":     userInfoServer(t, http.StatusOK, `<html>`),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := newUserInfoClient(srv.URL).Profile(context.Background(), "access-token")
			assert.Error(t, err)
		})
	}
}

func TestUserInfoNeverFollowsRedirects(t *testing.T) {
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("Authorization") != ""
	}))
	t.Cleanup(target.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	t.Cleanup(redirect.Close)

	_, err := newUserInfoClient(redirect.URL).Profile(context.Background(), "access-token")

	assert.Error(t, err)
	assert.False(t, leaked)
}
