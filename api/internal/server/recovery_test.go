package server

import (
	"bytes"
	"errors"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/httpx"
)

func TestRouterPanicDoesNotLogCredentialsOrRequestData(t *testing.T) {
	var recoveryLog bytes.Buffer
	previous := gin.DefaultErrorWriter
	gin.DefaultErrorWriter = &recoveryLog
	t.Cleanup(func() { gin.DefaultErrorWriter = previous })
	structured := captureLogger(t)
	r := NewRouter(Deps{})
	r.GET("/test-panic", func(c *gin.Context) { panic("private-health-data") })
	w := doRequest(r, http.MethodGet, "/test-panic?q=private-health-data", map[string]string{
		"Cookie":         "session=fixture-credential",
		"X-Internal-Key": "fixture-credential",
	})
	require.Equal(t, http.StatusInternalServerError, w.Code)
	for _, output := range []string{recoveryLog.String(), structured.String(), w.Body.String()} {
		require.NotContains(t, output, "fixture-credential")
		require.NotContains(t, output, "private-health-data")
	}
	require.Contains(t, structured.String(), `"panic":true`)
}

func TestRouterDoesNotLogSensitiveServiceErrorText(t *testing.T) {
	output := captureLogger(t)
	r := NewRouter(Deps{})
	r.GET("/test-error", func(c *gin.Context) {
		httpx.RespondServiceError(c, errors.New("database rejected private-health-fixture"))
	})
	w := doRequest(r, http.MethodGet, "/test-error", nil)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	require.NotContains(t, output.String(), "private-health-fixture")
	require.NotContains(t, w.Body.String(), "private-health-fixture")
}
