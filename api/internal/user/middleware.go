package user

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

const contextUserID = "user_id"
const contextUserLoc = "user_loc"

// requestUserIDContextKey is unexported so only this package can mint values
// under it -- a bare string key would let any importer collide with (or read)
// it accidentally.
type requestUserIDContextKey struct{}

// WithID stamps the resolved users.id onto a context.Context, so it survives
// into every downstream ctx derived from the request -- including the one
// ai.Resolver hands to the AgentGateway provider for cost attribution
// (kora#508). This is distinct from the gin-context-keyed contextUserID
// above: that one only reaches handlers still holding *gin.Context.
func WithID(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, requestUserIDContextKey{}, id)
}

// IDFromRequestContext reads the users.id stamped by WithID off a plain
// context.Context. Named distinctly from IDFromContext (which reads the
// *gin.Context* value set by ResolveMiddleware) so callers can't confuse the
// two: this one is for code that only has a context.Context, e.g. AI
// providers.
func IDFromRequestContext(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(requestUserIDContextKey{}).(uuid.UUID)
	return id, ok
}

// ResolveMiddleware provisions-and-resolves the authenticated user once per
// request, so every downstream handler can read a guaranteed users.id without
// each re-querying (and without a brand-new user 500ing on non-/me endpoints).
func ResolveMiddleware(repo Repository) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetString("uid")
		if uid == "" {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		u, err := repo.EnsureUser(c.Request.Context(), uid, c.GetString("email"), c.GetString("name"))
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
			return
		}
		c.Set(contextUserID, u.ID)
		c.Request = c.Request.WithContext(WithID(c.Request.Context(), u.ID))
		loc, err := time.LoadLocation(u.Timezone)
		if err != nil {
			loc = time.UTC
		}
		c.Set(contextUserLoc, loc)
		c.Next()
	}
}

// IDFromContext reads the users.id resolved by ResolveMiddleware earlier in
// the request chain.
func IDFromContext(c *gin.Context) (uuid.UUID, bool) {
	v, ok := c.Get(contextUserID)
	if !ok {
		return uuid.Nil, false
	}
	id, ok := v.(uuid.UUID)
	return id, ok
}

// SetIDForTest sets the gin-context user ID only. Unlike ResolveMiddleware,
// it does NOT stamp the request context via WithID—tests will not see the
// X-Kora-User-Id header sent to the gateway in production. Exported only so
// packages behind auth can test their handlers without a Firebase token.
func SetIDForTest(c *gin.Context, id uuid.UUID) { c.Set(contextUserID, id) }

// LocFromContext reads the *time.Location resolved by ResolveMiddleware
// earlier in the request chain, falling back to UTC if unset or invalid.
func LocFromContext(c *gin.Context) *time.Location {
	v, ok := c.Get(contextUserLoc)
	if !ok {
		return time.UTC
	}
	loc, ok := v.(*time.Location)
	if !ok {
		return time.UTC
	}
	return loc
}
