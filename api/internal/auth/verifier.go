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
	email, _ := tok.Claims["email"].(string)
	return Claims{UID: tok.UID, Email: email}, nil
}
