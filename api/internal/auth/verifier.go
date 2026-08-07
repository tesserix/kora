// Package auth verifies Firebase ID tokens and exposes identity to handlers.
package auth

import (
	"context"
	"fmt"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
)

type Claims struct {
	UID   string
	Email string
	Name  string
}

type TokenVerifier interface {
	Verify(ctx context.Context, idToken string) (Claims, error)
}

type firebaseVerifier struct {
	client *fbauth.Client
}

func NewFirebaseVerifier(ctx context.Context, projectID string) (TokenVerifier, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, fmt.Errorf("auth: init firebase app: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("auth: init auth client: %w", err)
	}
	return firebaseVerifier{client: client}, nil
}

func (v firebaseVerifier) Verify(ctx context.Context, idToken string) (Claims, error) {
	tok, err := v.client.VerifyIDToken(ctx, idToken)
	if err != nil {
		return Claims{}, fmt.Errorf("auth: verify token: %w", err)
	}
	return claimsFromToken(tok), nil
}

// claimsFromToken extracts the identity fields this package cares about from
// a verified Firebase token. Pulled out of Verify so it can be unit tested
// against a hand-built *fbauth.Token without a real Firebase client, which
// VerifyIDToken requires and cannot be faked in-process.
//
// Non-string or missing claims (e.g. a JSON number, or a token that never
// carried the claim) yield the zero value rather than panicking: a failed
// type assertion with the ", ok" form never panics, it just reports false.
func claimsFromToken(tok *fbauth.Token) Claims {
	email, _ := tok.Claims["email"].(string)
	name, _ := tok.Claims["name"].(string)
	return Claims{UID: tok.UID, Email: email, Name: name}
}
