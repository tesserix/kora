package auth

import (
	"testing"

	fbauth "firebase.google.com/go/v4/auth"
	"github.com/stretchr/testify/assert"
)

// buildToken constructs a *fbauth.Token with arbitrary claims for unit
// testing claimsFromToken without hitting real Firebase. fbauth.Token.Claims
// is an exported map[string]interface{}, so it can be populated directly;
// VerifyIDToken itself can't be exercised in-process since it needs a real
// Firebase client.
func buildToken(uid string, claims map[string]interface{}) *fbauth.Token {
	return &fbauth.Token{UID: uid, Claims: claims}
}

func TestClaimsFromTokenExtractsEmailAndNameWhenPresent(t *testing.T) {
	tok := buildToken("u1", map[string]interface{}{
		"email": "a@b.c",
		"name":  "Ada Lovelace",
	})

	claims := claimsFromToken(tok)

	assert.Equal(t, "u1", claims.UID)
	assert.Equal(t, "a@b.c", claims.Email)
	assert.Equal(t, "Ada Lovelace", claims.Name)
}

func TestClaimsFromTokenMissingNameClaimYieldsEmptyString(t *testing.T) {
	tok := buildToken("u1", map[string]interface{}{
		"email": "a@b.c",
	})

	claims := claimsFromToken(tok)

	assert.Empty(t, claims.Name)
	assert.Equal(t, "a@b.c", claims.Email)
}

func TestClaimsFromTokenMissingEmailClaimYieldsEmptyString(t *testing.T) {
	tok := buildToken("u1", map[string]interface{}{
		"name": "Ada Lovelace",
	})

	claims := claimsFromToken(tok)

	assert.Empty(t, claims.Email)
	assert.Equal(t, "Ada Lovelace", claims.Name)
}

func TestClaimsFromTokenNonStringNameClaimYieldsEmptyStringWithoutPanic(t *testing.T) {
	tok := buildToken("u1", map[string]interface{}{
		"email": "a@b.c",
		"name":  12345, // a JSON number, not a string
	})

	var claims Claims
	assert.NotPanics(t, func() {
		claims = claimsFromToken(tok)
	})
	assert.Empty(t, claims.Name)
}

func TestClaimsFromTokenNonStringEmailClaimYieldsEmptyStringWithoutPanic(t *testing.T) {
	tok := buildToken("u1", map[string]interface{}{
		"email": 12345, // a JSON number, not a string
		"name":  "Ada Lovelace",
	})

	var claims Claims
	assert.NotPanics(t, func() {
		claims = claimsFromToken(tok)
	})
	assert.Empty(t, claims.Email)
}
