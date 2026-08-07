package appleid

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type capturedRequest struct {
	method string
	url    string
	form   url.Values
}

// fakeTransport records the request and replays a canned response, so no test
// reaches Apple.
type fakeTransport struct {
	captured *capturedRequest
	status   int
	body     string
	err      error
}

func (f *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if f.err != nil {
		return nil, f.err
	}
	raw, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(raw))
	*f.captured = capturedRequest{method: r.Method, url: r.URL.String(), form: form}
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     make(http.Header),
	}, nil
}

func testKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	return key
}

func newTestClient(t *testing.T, ft *fakeTransport) *Client {
	t.Helper()
	c := NewClient(Config{
		TeamID:     "TEAM123456",
		KeyID:      "KEY7890AB",
		BundleID:   "com.tesserix.kora",
		PrivateKey: testKey(t),
	}, &http.Client{Transport: ft})
	c.BaseURL = "https://appleid.example"
	c.Now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	return c
}

func TestClientSecretCarriesAppleRequiredClaims(t *testing.T) {
	c := newTestClient(t, &fakeTransport{captured: &capturedRequest{}})

	secret, err := c.clientSecret()
	require.NoError(t, err)

	parsed, _, err := jwt.NewParser().ParseUnverified(secret, jwt.MapClaims{})
	require.NoError(t, err)

	assert.Equal(t, "ES256", parsed.Header["alg"])
	assert.Equal(t, "KEY7890AB", parsed.Header["kid"])

	claims := parsed.Claims.(jwt.MapClaims)
	assert.Equal(t, "TEAM123456", claims["iss"])
	assert.Equal(t, "https://appleid.apple.com", claims["aud"])
	// `sub` is the BUNDLE ID for the native flow. A Services ID here yields a
	// bare invalid_client from Apple.
	assert.Equal(t, "com.tesserix.kora", claims["sub"])
	assert.Equal(t, float64(1_700_000_000), claims["iat"])
	assert.Equal(t, float64(1_700_000_000+300), claims["exp"])
}

func TestClientSecretIsSignedWithTheConfiguredKey(t *testing.T) {
	c := newTestClient(t, &fakeTransport{captured: &capturedRequest{}})

	secret, err := c.clientSecret()
	require.NoError(t, err)

	parser := jwt.NewParser(jwt.WithoutClaimsValidation())

	// Verifies against the REAL key, then against a DIFFERENT key. Without the
	// second half this passes against an unsigned or wrongly-signed token.
	// Claim validation is off deliberately: this test is about the signature,
	// and `exp` is pinned to a fixed clock that is always in the past by the
	// time the suite runs. Expiry is covered by
	// TestClientSecretCarriesAppleRequiredClaims.
	_, err = parser.Parse(secret, func(*jwt.Token) (any, error) { return &c.cfg.PrivateKey.PublicKey, nil })
	assert.NoError(t, err)

	other := testKey(t)
	_, err = parser.Parse(secret, func(*jwt.Token) (any, error) { return &other.PublicKey, nil })
	assert.Error(t, err)
}

func TestClientSecretIsFreshPerCall(t *testing.T) {
	c := newTestClient(t, &fakeTransport{captured: &capturedRequest{}})
	calls := 0
	c.Now = func() time.Time { calls++; return time.Unix(int64(1_700_000_000+calls), 0) }

	first, err := c.clientSecret()
	require.NoError(t, err)
	second, err := c.clientSecret()
	require.NoError(t, err)

	// Proves the secret is minted per request rather than cached — the whole
	// reason there is no rotation story.
	assert.NotEqual(t, first, second)
}

func TestExchangeAuthorizationCodePostsTheRightForm(t *testing.T) {
	captured := &capturedRequest{}
	c := newTestClient(t, &fakeTransport{captured: captured, body: `{"refresh_token":"rt-abc"}`})

	token, err := c.ExchangeAuthorizationCode(context.Background(), "auth-code-xyz")

	require.NoError(t, err)
	assert.Equal(t, "rt-abc", token)
	assert.Equal(t, http.MethodPost, captured.method)
	assert.Equal(t, "https://appleid.example/auth/token", captured.url)
	assert.Equal(t, "authorization_code", captured.form.Get("grant_type"))
	assert.Equal(t, "auth-code-xyz", captured.form.Get("code"))
	// The bundle ID, not a Services ID.
	assert.Equal(t, "com.tesserix.kora", captured.form.Get("client_id"))
	assert.NotEmpty(t, captured.form.Get("client_secret"))
}

func TestExchangeAuthorizationCodeErrorsOnNonOK(t *testing.T) {
	captured := &capturedRequest{}
	c := newTestClient(t, &fakeTransport{
		captured: captured,
		status:   http.StatusBadRequest,
		body:     `{"error":"invalid_client"}`,
	})

	_, err := c.ExchangeAuthorizationCode(context.Background(), "code")

	require.Error(t, err)
	// The Apple error code must survive into the message — invalid_client is
	// the symptom of a Services ID in client_id, and it is undebuggable
	// without this.
	assert.Contains(t, err.Error(), "invalid_client")
}

func TestExchangeAuthorizationCodeErrorsWhenNoRefreshTokenReturned(t *testing.T) {
	captured := &capturedRequest{}
	c := newTestClient(t, &fakeTransport{captured: captured, body: `{"access_token":"at-only"}`})

	_, err := c.ExchangeAuthorizationCode(context.Background(), "code")

	// A 200 with no refresh_token is useless to us and must not be reported as
	// success — storing "" would look identical to never having captured one.
	require.Error(t, err)
	assert.Contains(t, err.Error(), "refresh token")
}

func TestRevokeRefreshTokenPostsTheRightForm(t *testing.T) {
	captured := &capturedRequest{}
	c := newTestClient(t, &fakeTransport{captured: captured, body: ``})

	err := c.RevokeRefreshToken(context.Background(), "rt-abc")

	require.NoError(t, err)
	assert.Equal(t, http.MethodPost, captured.method)
	assert.Equal(t, "https://appleid.example/auth/revoke", captured.url)
	assert.Equal(t, "rt-abc", captured.form.Get("token"))
	assert.Equal(t, "refresh_token", captured.form.Get("token_type_hint"))
	assert.Equal(t, "com.tesserix.kora", captured.form.Get("client_id"))
	assert.NotEmpty(t, captured.form.Get("client_secret"))
}

func TestRevokeRefreshTokenErrorsOnNonOK(t *testing.T) {
	captured := &capturedRequest{}
	c := newTestClient(t, &fakeTransport{captured: captured, status: http.StatusUnauthorized, body: `{"error":"invalid_grant"}`})

	err := c.RevokeRefreshToken(context.Background(), "rt-abc")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid_grant")
}

func TestParsePrivateKeyRejectsNonPEM(t *testing.T) {
	_, err := ParsePrivateKey([]byte("not a pem block"))
	assert.Error(t, err)
}

func TestParsePrivateKeyRoundTripsAPKCS8Key(t *testing.T) {
	key := testKey(t)
	pemBytes := encodePKCS8PEM(t, key)

	parsed, err := ParsePrivateKey(pemBytes)

	require.NoError(t, err)
	assert.Equal(t, key.D, parsed.D)
}

func encodePKCS8PEM(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}
