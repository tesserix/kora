package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type verifiedTokenContextKey struct{}

// WithVerifiedToken carries a Firebase token only after TokenVerifier has
// accepted it. Outbound AI clients use this delegated credential so the mesh
// can authorize the logged-in user as well as the calling workload.
func WithVerifiedToken(ctx context.Context, token string) context.Context {
	if token == "" {
		return ctx
	}
	return context.WithValue(ctx, verifiedTokenContextKey{}, token)
}

// VerifiedTokenFromContext returns the already-verified Firebase token for
// delegation to an internal user-aware service. Callers must never log it.
func VerifiedTokenFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(verifiedTokenContextKey{}).(string)
	return token, ok && token != ""
}

func Middleware(v TokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || token == "" {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		claims, err := v.Verify(c.Request.Context(), token)
		if err != nil {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		c.Set("uid", claims.UID)
		c.Set("email", claims.Email)
		c.Set("name", claims.Name)
		c.Request = c.Request.WithContext(WithVerifiedToken(c.Request.Context(), token))
		c.Next()
	}
}
