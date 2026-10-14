package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestZitadelDeleterDeletesTheSubjectWithTheToken(t *testing.T) {
	var method, path, authz string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, authz = r.Method, r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"details":{}}`))
	}))
	t.Cleanup(srv.Close)

	err := newZitadelDeleter(srv.URL+"/", "pat").DeleteIdentity(context.Background(), "394000000000000042")

	require.NoError(t, err)
	assert.Equal(t, http.MethodDelete, method)
	assert.Equal(t, "/v2/users/394000000000000042", path)
	assert.Equal(t, "Bearer pat", authz)
}

func TestZitadelDeleterTreatsAMissingUserAsDeleted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	assert.NoError(t, newZitadelDeleter(srv.URL, "pat").DeleteIdentity(context.Background(), "gone"))
}

func TestZitadelDeleterFails(t *testing.T) {
	for name, status := range map[string]int{
		"forbidden":    http.StatusForbidden,
		"server error": http.StatusInternalServerError,
		"redirect":     http.StatusFound,
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if status == http.StatusFound {
					w.Header().Set("Location", "https://elsewhere.example.test/")
				}
				w.WriteHeader(status)
			}))
			t.Cleanup(srv.Close)

			assert.Error(t, newZitadelDeleter(srv.URL, "pat").DeleteIdentity(context.Background(), "394000000000000042"))
		})
	}
}

func TestZitadelDeleterRejectsEmptySubjectAndToken(t *testing.T) {
	assert.ErrorContains(t, newZitadelDeleter("http://unused", "pat").DeleteIdentity(context.Background(), ""), "empty subject")
	_, err := NewZitadelIdentityDeleter("http://unused", " ")
	assert.ErrorContains(t, err, "token is required")
}
