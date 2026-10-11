package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	fbauth "firebase.google.com/go/v4/auth"
)

const maxAccountResponse = 1 << 20

// accountStatusClient uses the authenticated user's own Firebase account lookup.
// https://firebase.google.com/docs/reference/rest/auth#section-get-account-info
// No administrative account read permission is required. The ID token is first
// verified by the SDK, and auth_time is compared with Firebase's validSince.
type accountStatusClient struct {
	apiKey   string
	endpoint string
	http     *http.Client
}

func newAccountStatusClient(apiKey string) *accountStatusClient {
	return &accountStatusClient{apiKey: apiKey, endpoint: "https://identitytoolkit.googleapis.com/v1/accounts:lookup", http: &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (c *accountStatusClient) check(ctx context.Context, raw string, tok *fbauth.Token) error {
	if tok == nil || tok.UID == "" || tok.AuthTime <= 0 {
		return errors.New("auth: invalid verified identity")
	}
	body, err := json.Marshal(struct {
		IDToken string `json:"idToken"`
	}{raw})
	if err != nil {
		return errors.New("auth: account status unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"?key="+url.QueryEscape(c.apiKey), bytes.NewReader(body))
	if err != nil {
		return errors.New("auth: account status unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		return errors.New("auth: account status unavailable")
	}
	defer func() {
		// The body is fully read below; a close error cannot change verification.
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return errors.New("auth: account status rejected")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxAccountResponse+1))
	if err != nil || len(data) > maxAccountResponse {
		return errors.New("auth: account status unavailable")
	}
	var result struct {
		Users []struct {
			UID        string `json:"localId"`
			ValidSince string `json:"validSince"`
			Disabled   bool   `json:"disabled"`
		} `json:"users"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.Users) != 1 {
		return errors.New("auth: invalid account status")
	}
	user := result.Users[0]
	if user.UID != tok.UID || user.Disabled {
		return errors.New("auth: account unavailable")
	}
	validSince, err := strconv.ParseInt(user.ValidSince, 10, 64)
	if err != nil || validSince < 0 {
		return errors.New("auth: invalid revocation boundary")
	}
	if tok.AuthTime < validSince {
		return errors.New("auth: session revoked")
	}
	return nil
}
