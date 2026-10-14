package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// zitadelDeleter removes a Zitadel user with a machine user's personal access
// token, the same credential shape mark8ly's auth-bff uses for its user API
// calls. Deleting the user also drops its IdP links, which is Kora's whole
// part of Apple and Google account removal; revoking the Apple grant itself is
// a platform concern (tesserix/tesserix-k8s#1388).
type zitadelDeleter struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewZitadelIdentityDeleter(baseURL, token string) (IdentityDeleter, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("auth: zitadel deleter token is required")
	}
	return newZitadelDeleter(baseURL, token), nil
}

func newZitadelDeleter(baseURL, token string) zitadelDeleter {
	return zitadelDeleter{baseURL: strings.TrimSuffix(baseURL, "/"), token: token, http: &http.Client{
		Timeout: 10 * time.Second,
		// Never forward the admin token to wherever a redirect points.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// DeleteIdentity removes the Zitadel user for subject.
//
// An empty subject is rejected rather than passed through: the account-deletion
// caller treats an identity failure as NON-fatal, so a silent no-op here would
// leave a live identity behind while reporting success.
//
// 404 counts as success. The user is already gone, which is the outcome asked
// for, and it makes a retried deletion converge instead of failing forever.
func (d zitadelDeleter) DeleteIdentity(ctx context.Context, subject string) error {
	if subject == "" {
		return errors.New("auth: delete identity: empty subject")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, d.baseURL+"/v2/users/"+url.PathEscape(subject), nil)
	if err != nil {
		return fmt.Errorf("auth: delete identity: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+d.token)
	res, err := d.http.Do(req)
	if err != nil {
		return fmt.Errorf("auth: delete identity: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxUserInfoResponse))
	if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("auth: delete identity: status %d", res.StatusCode)
}
