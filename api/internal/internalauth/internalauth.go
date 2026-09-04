// Package internalauth guards service-to-service routes with a shared key.
package internalauth

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Header carries the shared key presented by in-cluster callers such as kora-mcp.
const Header = "X-Internal-Key"

// Middleware rejects requests whose X-Internal-Key does not match key.
func Middleware(key string) gin.HandlerFunc {
	expected := []byte(key)
	return func(c *gin.Context) {
		provided := []byte(c.GetHeader(Header))
		if len(expected) == 0 || subtle.ConstantTimeCompare(provided, expected) != 1 {
			httpx.Error(c, http.StatusUnauthorized, "unauthenticated", "invalid internal key")
			c.Abort()
			return
		}
		c.Next()
	}
}
