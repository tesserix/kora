package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/resolve"
)

func TestHealthEndpoint(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/health", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestUnknownRouteReturnsEnvelope(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/nope", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.JSONEq(t, `{"error":"not_found","message":"route not found"}`, w.Body.String())
}

type stubVerifier struct{}

func (stubVerifier) Verify(ctx context.Context, idToken string) (auth.Claims, error) {
	return auth.Claims{}, nil
}

func hasRoute(routes gin.RoutesInfo, method, path string) bool {
	for _, r := range routes {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}

func TestResolveRoutesRegisteredWhenResolverSet(t *testing.T) {
	h := resolve.NewHandler(nil, nil) // never invoked — we only inspect registration
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, Resolver: &h})
	routes := r.Routes()
	for _, p := range []string{"/v1/resolve/text", "/v1/resolve/photo", "/v1/resolve/voice", "/v1/resolve/barcode"} {
		if !hasRoute(routes, "POST", p) {
			t.Errorf("expected POST %s to be registered", p)
		}
	}
}

func TestLogUpdateRouteRegistered(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	if !hasRoute(r.Routes(), "PATCH", "/v1/logs/:id") {
		t.Error("expected PATCH /v1/logs/:id to be registered")
	}
}

func TestResolveRoutesAbsentWhenResolverNil(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}}) // Resolver nil
	if hasRoute(r.Routes(), "POST", "/v1/resolve/text") {
		t.Error("resolve routes must not be registered when Resolver is nil")
	}
	if hasRoute(r.Routes(), "POST", "/v1/resolve/voice") {
		t.Error("resolve voice route must not be registered when Resolver is nil")
	}
}
