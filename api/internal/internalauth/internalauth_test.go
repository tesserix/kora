package internalauth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func newRouter(key string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/internal/ping", Middleware(key), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	return r
}

func TestMiddlewareRejectsMissingOrWrongKey(t *testing.T) {
	r := newRouter("correct-horse-battery")
	for _, provided := range []string{"", "wrong"} {
		req := httptest.NewRequest(http.MethodGet, "/internal/ping", nil)
		if provided != "" {
			req.Header.Set(Header, provided)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	}
}

func TestMiddlewareAcceptsMatchingKey(t *testing.T) {
	r := newRouter("correct-horse-battery")
	req := httptest.NewRequest(http.MethodGet, "/internal/ping", nil)
	req.Header.Set(Header, "correct-horse-battery")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestMiddlewareFailsClosedWithEmptyKey(t *testing.T) {
	r := newRouter("")
	req := httptest.NewRequest(http.MethodGet, "/internal/ping", nil)
	req.Header.Set(Header, "")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
