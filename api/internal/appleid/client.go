// Package appleid talks to Apple's identity service. It exists to support
// account deletion: Apple has required since June 2022 that an app offering
// Sign in with Apple revoke the user's refresh token when their account is
// deleted, and Firebase never hands that refresh token to us — it has to be
// obtained by exchanging the authorization code the native sign-in returns.
package appleid

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

const (
	defaultBaseURL = "https://appleid.apple.com"
	audience       = "https://appleid.apple.com"
	// Apple permits up to six months. A short life means the secret is never
	// worth storing, which removes any rotation story: the .p8 key is then the
	// only long-lived secret.
	clientSecretTTL = 5 * time.Minute
)

type Config struct {
	TeamID string
	KeyID  string
	// BundleID is the app's bundle identifier and is sent as `client_id`.
	// The authorization code comes from the NATIVE iOS flow, where Apple
	// expects the bundle ID. A Services ID belongs to the web/Android flow
	// (Firebase uses one for its own config) and produces a bare
	// `invalid_client` here with no further explanation.
	BundleID   string
	PrivateKey *ecdsa.PrivateKey
}

type Client struct {
	cfg  Config
	http *http.Client
	// BaseURL and Now are exported so tests can pin them. Production never
	// sets either.
	BaseURL string
	Now     func() time.Time
}

func NewClient(cfg Config, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{cfg: cfg, http: httpClient, BaseURL: defaultBaseURL, Now: time.Now}
}

// ParsePrivateKey reads an Apple .p8 key, which is PEM-wrapped PKCS#8.
func ParsePrivateKey(pemBytes []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("appleid: private key is not PEM encoded")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("appleid: parse private key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("appleid: private key is %T, want *ecdsa.PrivateKey", parsed)
	}
	return key, nil
}

func (c *Client) clientSecret() (string, error) {
	now := c.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": c.cfg.TeamID,
		"iat": now.Unix(),
		"exp": now.Add(clientSecretTTL).Unix(),
		"aud": audience,
		"sub": c.cfg.BundleID,
	})
	tok.Header["kid"] = c.cfg.KeyID
	signed, err := tok.SignedString(c.cfg.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("appleid: sign client secret: %w", err)
	}
	return signed, nil
}

// post sends a form to an Apple endpoint and returns the body on 2xx.
func (c *Client) post(ctx context.Context, path string, form url.Values) ([]byte, error) {
	secret, err := c.clientSecret()
	if err != nil {
		return nil, err
	}
	form.Set("client_id", c.cfg.BundleID)
	form.Set("client_secret", secret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("appleid: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("appleid: %s: %w", path, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// Apple's error code is the only diagnostic it gives; losing it here
		// makes invalid_client (a Services ID in client_id) undebuggable.
		return nil, fmt.Errorf("appleid: %s: status %d: %s", path, res.StatusCode, string(body))
	}
	return body, nil
}

// ExchangeAuthorizationCode trades a one-time authorization code for the
// long-lived refresh token that revocation needs.
func (c *Client) ExchangeAuthorizationCode(ctx context.Context, code string) (string, error) {
	body, err := c.post(ctx, "/auth/token", url.Values{
		"grant_type": {"authorization_code"},
		"code":       {code},
	})
	if err != nil {
		return "", err
	}
	var parsed struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("appleid: decode token response: %w", err)
	}
	if parsed.RefreshToken == "" {
		// Storing "" would be indistinguishable from never having captured a
		// token, and the failure would only surface at deletion time.
		return "", fmt.Errorf("appleid: token response carried no refresh token")
	}
	return parsed.RefreshToken, nil
}

// RevokeRefreshToken is consumed by account deletion (slice 2).
func (c *Client) RevokeRefreshToken(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		// Every row provisioned by Repository.UpsertByFirebaseUID starts with
		// '' rather than SQL NULL in apple_refresh_token (see the migration
		// and model.go comments), so a caller that checks `IS NULL` instead
		// of `!= ""` will pass an empty token here. POSTing token= to Apple
		// would be a wasted call at best and a confusing error at worst;
		// refuse it before it leaves the process.
		return fmt.Errorf("appleid: refresh token is empty")
	}
	_, err := c.post(ctx, "/auth/revoke", url.Values{
		"token":           {refreshToken},
		"token_type_hint": {"refresh_token"},
	})
	return err
}
