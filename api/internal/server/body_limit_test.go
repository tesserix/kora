package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestRouterBoundsRequestBodies(t *testing.T) {
	for _, knownLength := range []bool{true, false} {
		t.Run(map[bool]string{true: "content-length", false: "chunked"}[knownLength], func(t *testing.T) {
			r := NewRouter(Deps{})
			r.POST("/test-body", func(c *gin.Context) {
				_, err := io.ReadAll(c.Request.Body)
				if err != nil {
					c.Status(http.StatusBadRequest)
					return
				}
				c.Status(http.StatusNoContent)
			})
			req := httptest.NewRequest(http.MethodPost, "/test-body", strings.NewReader(strings.Repeat("x", (1<<20)+1)))
			req.Header.Set("Content-Type", "application/json")
			if !knownLength {
				req.ContentLength = -1
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			require.Contains(t, []int{http.StatusRequestEntityTooLarge, http.StatusBadRequest}, w.Code)
		})
	}
}

func TestRouterAllowsVoiceSizedMultipartBody(t *testing.T) {
	r := NewRouter(Deps{})
	r.POST("/test-body", func(c *gin.Context) {
		n, err := io.Copy(io.Discard, c.Request.Body)
		require.NoError(t, err)
		require.EqualValues(t, 12<<20, n)
		c.Status(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodPost, "/test-body", strings.NewReader(strings.Repeat("x", 12<<20)))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNoContent, w.Code)
}
