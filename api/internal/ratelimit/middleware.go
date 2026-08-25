package ratelimit

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// PerUser limits each authenticated caller to limit requests per period.
//
// The key is the AUTHENTICATED USER ID, not the client IP: a mobile client's IP
// is a carrier NAT shared by thousands of people, so limiting on it would
// throttle strangers for each other while a single account behind many IPs
// would not be limited at all.
//
// An unauthenticated request is refused with 401 rather than limited under a
// shared empty key -- one bucket for every anonymous caller is a free
// enumeration channel for the first one to use it.
func PerUser(limit int, period time.Duration) gin.HandlerFunc {
	w := NewWindow(limit, period)
	return func(c *gin.Context) {
		id, ok := user.IDFromContext(c)
		if !ok {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		if !w.Allow(id.String(), time.Now()) {
			// httpx.Error calls AbortWithStatusJSON, so the handler never runs.
			httpx.Error(c, http.StatusTooManyRequests, "rate_limited",
				"Too many lookups. Try again in a minute.")
			return
		}
		c.Next()
	}
}
