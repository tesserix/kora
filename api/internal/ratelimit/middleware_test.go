package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

func routerWithUser(t *testing.T, id uuid.UUID, limit int) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/thing",
		func(c *gin.Context) { user.SetIDForTest(c, id); c.Next() },
		PerUser(limit, time.Minute),
		func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"data": "ok"}) })
	return r
}

func call(r *gin.Engine) int {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/thing", nil))
	return rec.Code
}

func TestPerUser_RefusesPastTheLimitWith429(t *testing.T) {
	r := routerWithUser(t, uuid.New(), 2)
	require.Equal(t, 200, call(r))
	require.Equal(t, 200, call(r))
	require.Equal(t, http.StatusTooManyRequests, call(r))
}

// A refusal must ABORT. If the middleware only sets a status and calls Next,
// the handler still runs and still answers — the limit would be decorative.
func TestPerUser_RefusalNeverReachesTheHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	id := uuid.New()
	reached := 0
	r := gin.New()
	r.GET("/thing",
		func(c *gin.Context) { user.SetIDForTest(c, id); c.Next() },
		PerUser(1, time.Minute),
		func(c *gin.Context) { reached++; c.JSON(200, gin.H{"data": "ok"}) })

	call(r)
	call(r)
	require.Equal(t, 1, reached, "the refused request must not reach the handler")
}

// An unauthenticated request has no key to limit on. It must be refused
// outright rather than sharing one bucket labelled "" with every other
// anonymous caller — which would be a free enumeration channel.
func TestPerUser_UnauthenticatedIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/thing", PerUser(5, time.Minute), func(c *gin.Context) { c.JSON(200, gin.H{}) })
	require.Equal(t, http.StatusUnauthorized, call(r))
}
