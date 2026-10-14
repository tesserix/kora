// Package auth verifies Zitadel access tokens and exposes identity to handlers.
package auth

import "context"

// Claims is the verified identity of a request. Zitadel access tokens carry
// only UID (the subject); Email and Name stay empty and the user package
// fills them from userinfo when a row needs them.
type Claims struct {
	UID   string
	Email string
	Name  string
}

type TokenVerifier interface {
	Verify(ctx context.Context, token string) (Claims, error)
}

// IdentityDeleter removes a user from the identity provider. Deliberately a
// separate interface from TokenVerifier: verification needs only the
// issuer's public keys, deletion needs an administrative credential.
type IdentityDeleter interface {
	DeleteIdentity(ctx context.Context, subject string) error
}
