package notifications

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/groups"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	svc := NewService(NewRepository(db), groups.NewRepository(db))
	h := NewHandler(svc)
	r.GET("/v1/notifications", h.List)
	r.GET("/v1/notifications/unread-count", h.UnreadCount)
	r.POST("/v1/notifications/read", h.MarkAllRead)
	return r
}

func do(r *gin.Engine, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestNotificationEndpoints(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	actor := seedUser(t, db, "Actor")
	require.NoError(t, NewRepository(db).Create(context.Background(), Notification{UserID: me, ActorID: actor, Type: TypeFriendRequest}))

	r := mountFor(me, db)
	require.Equal(t, http.StatusOK, do(r, http.MethodGet, "/v1/notifications").Code)
	require.Equal(t, http.StatusOK, do(r, http.MethodGet, "/v1/notifications/unread-count").Code)
	require.Equal(t, http.StatusOK, do(r, http.MethodPost, "/v1/notifications/read").Code)
}

func TestNotificationsUnauthorized(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New() // no user_id middleware
	svc := NewService(NewRepository(db), groups.NewRepository(db))
	h := NewHandler(svc)
	r.GET("/v1/notifications", h.List)
	require.Equal(t, http.StatusUnauthorized, do(r, http.MethodGet, "/v1/notifications").Code)
}
