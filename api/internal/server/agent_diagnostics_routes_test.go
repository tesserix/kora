package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"gorm.io/gorm"
)

func TestAgentDiagnosticsAreNotOnTheAppUserGroup(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, Agents: testCoordinator()})

	routes := r.Routes()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/v1/agents"},
		{http.MethodGet, "/v1/agents/:name"},
		{http.MethodPost, "/v1/agents/:name/refresh"},
	} {
		assert.False(t, hasRoute(routes, tc.method, tc.path), "%s %s is reachable with only a Firebase login", tc.method, tc.path)
	}
}

func TestAgentDiagnosticsRequireThePlatformSignature(t *testing.T) {
	r := NewRouter(Deps{
		DB: &gorm.DB{}, Verifier: stubVerifier{},
		PlatformAdminSecret: platformTestSecret,
		Agents:              testCoordinator(),
	})

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/v1/admin/agents"},
		{http.MethodGet, "/v1/admin/agents/nutrition-coach"},
		{http.MethodPost, "/v1/admin/agents/nutrition-coach/refresh"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			assert.Equal(t, http.StatusUnauthorized, serve(r, httptest.NewRequest(tc.method, tc.path, nil)).Code)
		})
	}
}

func TestAgentDiagnosticsAreNotMountedWithoutAPlatformSecret(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, Agents: testCoordinator()})

	assert.Equal(t, http.StatusNotFound, serve(r, signPlatform(t, "/v1/admin/agents")).Code)
}

func TestAPlatformAdminReachesTheAgentCatalog(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM platform_request_nonces") })
	r := NewRouter(Deps{
		DB: db, Verifier: stubVerifier{},
		PlatformAdminSecret: platformTestSecret,
		Agents:              testCoordinator(),
	})

	// The test registry is unreachable, so getting past the gate means 502.
	assert.Equal(t, http.StatusBadGateway, serve(r, signPlatform(t, "/v1/admin/agents")).Code)
}
