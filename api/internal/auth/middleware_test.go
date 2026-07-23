package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

type fakeVerifier struct {
	claims Claims
	err    error
}

func (f fakeVerifier) Verify(_ context.Context, _ string) (Claims, error) {
	return f.claims, f.err
}

func setup(v TokenVerifier) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/protected", Middleware(v), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"uid": c.GetString("uid")})
	})
	return r
}

func TestMiddlewareAcceptsValidToken(t *testing.T) {
	r := setup(fakeVerifier{claims: Claims{UID: "u123", Email: "a@b.c"}})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer good-token")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"uid":"u123"}`, w.Body.String())
}

func TestMiddlewareRejectsMissingHeader(t *testing.T) {
	r := setup(fakeVerifier{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.JSONEq(t, `{"error":"unauthorized","message":"invalid or missing token"}`, w.Body.String())
}

func TestMiddlewareRejectsBadToken(t *testing.T) {
	r := setup(fakeVerifier{err: errors.New("expired")})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
