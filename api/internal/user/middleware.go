package user

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

const contextUserID = "user_id"
const contextUserLoc = "user_loc"

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

// SetIDForTest puts a user id on the context the same way the auth middleware
// does. Exported only so packages that sit BEHIND auth can test their own
// middleware without a Firebase token.
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
