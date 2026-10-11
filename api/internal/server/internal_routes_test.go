package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/internalauth"
)

// Built at runtime so no literal key-shaped string is committed.
var internalTestKey = strings.Repeat("k", 24)

func TestInternalFoodsIsNotMountedWithoutAKey(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	req := httptest.NewRequest(http.MethodGet, "/internal/v1/foods?q=apple", nil)
	req.Header.Set(internalauth.Header, internalTestKey)
	assert.Equal(t, http.StatusNotFound, serve(r, req).Code)
}

func TestInternalFoodsRejectsAWrongKey(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, MCPInternalKey: internalTestKey})
	req := httptest.NewRequest(http.MethodGet, "/internal/v1/foods?q=apple", nil)
	req.Header.Set(internalauth.Header, "not-the-key")
	assert.Equal(t, http.StatusUnauthorized, serve(r, req).Code)
}

func TestInternalFoodsReachesTheSearchHandlerWithTheKey(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, MCPInternalKey: internalTestKey})
	// A one-character query is rejected by Search before any DB access.
	req := httptest.NewRequest(http.MethodGet, "/internal/v1/foods?q=a", nil)
	req.Header.Set(internalauth.Header, internalTestKey)
	assert.Equal(t, http.StatusBadRequest, serve(r, req).Code)
}
