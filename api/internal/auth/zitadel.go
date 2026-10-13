package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// zitadelVerifier checks Zitadel JWT access tokens entirely locally:
// signature against the issuer's JWKS, issuer, expiry and audience. Nothing on
// the request path calls Zitadel. go-oidc caches the key set and refetches on
// an unknown kid, so one verifier is built at startup and reused.
//
// The access token carries only the subject. Email and name live behind
// userinfo, which UserInfoClient fetches only when a user row needs them; see
// user.Repository.EnsureUser. Putting that call on every request is the
// mistake tesserix-home/platform-auth made and reverted (#450, #453).
type zitadelVerifier struct {
	verifier  *oidc.IDTokenVerifier
	projectID string
}

// NewZitadelVerifier performs issuer discovery once. A failure stops startup:
// an API that cannot verify tokens can only reject every request, which is a
// harder outage to read than a refusal to boot.
func NewZitadelVerifier(ctx context.Context, issuer, projectID string) (TokenVerifier, *UserInfoClient, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, nil, errors.New("auth: zitadel project id is required")
	}
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, nil, fmt.Errorf("auth: zitadel discovery at %s: %w", issuer, err)
	}
	if provider.UserInfoEndpoint() == "" {
		return nil, nil, fmt.Errorf("auth: zitadel discovery at %s: no userinfo endpoint", issuer)
	}
	verifier := newZitadelVerifier(provider.VerifierContext(ctx, verifierConfig()), projectID)
	return verifier, newUserInfoClient(provider.UserInfoEndpoint()), nil
}

// verifierConfig skips go-oidc's client-id check because the audience to pin is
// the PROJECT id, which the app requests through the
// urn:zitadel:iam:org:project:id:{projectId}:aud scope. Zitadel also lists the
// app's client id in aud, which differs per platform (iOS, Android), so the
// project id is the one value every legitimate token shares.
func verifierConfig() *oidc.Config {
	return &oidc.Config{SkipClientIDCheck: true}
}

func newZitadelVerifier(v *oidc.IDTokenVerifier, projectID string) zitadelVerifier {
	return zitadelVerifier{verifier: v, projectID: projectID}
}

func (v zitadelVerifier) Verify(ctx context.Context, raw string) (Claims, error) {
	// An opaque Zitadel token is not a JWT. Name that rather than reporting a
	// parse failure, because it means an app was provisioned with bearer
	// access tokens instead of JWT.
	if strings.Count(raw, ".") != 2 {
		return Claims{}, errors.New("auth: verify token: not a JWT")
	}
	tok, err := v.verifier.Verify(ctx, raw)
	if err != nil {
		return Claims{}, fmt.Errorf("auth: verify token: %w", err)
	}
	if !slices.Contains(tok.Audience, v.projectID) {
		return Claims{}, errors.New("auth: verify token: audience does not include the kora project")
	}
	if tok.Subject == "" {
		return Claims{}, errors.New("auth: verify token: empty subject")
	}
	return Claims{UID: tok.Subject}, nil
}

// Profile is the subset of Zitadel userinfo Kora stores on its own user row.
type Profile struct {
	Email string
	Name  string
}

const maxUserInfoResponse = 1 << 20

// UserInfoClient reads the caller's own profile with their access token. The
// token already carries the openid, profile and email scopes, so no
// administrative credential is involved.
type UserInfoClient struct {
	endpoint string
	http     *http.Client
}

func newUserInfoClient(endpoint string) *UserInfoClient {
	return &UserInfoClient{endpoint: endpoint, http: &http.Client{
		Timeout: 5 * time.Second,
		// Never forward the bearer token to wherever a redirect points.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (c *UserInfoClient) Profile(ctx context.Context, accessToken string) (Profile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint, nil)
	if err != nil {
		return Profile{}, fmt.Errorf("auth: userinfo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	res, err := c.http.Do(req)
	if err != nil {
		return Profile{}, fmt.Errorf("auth: userinfo: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Profile{}, fmt.Errorf("auth: userinfo: status %d", res.StatusCode)
	}
	var body struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxUserInfoResponse)).Decode(&body); err != nil {
		return Profile{}, fmt.Errorf("auth: userinfo decode: %w", err)
	}
	// Friend requests look users up by email, so an unverified address must
	// never become one: anyone could register with somebody else's.
	if !body.EmailVerified {
		body.Email = ""
	}
	return Profile{Email: body.Email, Name: body.Name}, nil
}
