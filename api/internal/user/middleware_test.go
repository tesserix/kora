package user

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func mwTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func TestResolveMiddlewareSetsUserID(t *testing.T) {
	db := mwTestDB(t)
	repo := NewRepository(db)
	gin.SetMode(gin.TestMode)
	fuid := "mw-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Set("email", "mw@test.dev"); c.Next() })
	r.Use(ResolveMiddleware(repo))
	r.GET("/x", func(c *gin.Context) {
		id, ok := IDFromContext(c)
		require.True(t, ok)
		require.NotEqual(t, uuid.Nil, id)
		c.JSON(http.StatusOK, gin.H{"id": id.String()})
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestResolveMiddlewareRejectsMissingUID(t *testing.T) {
	db := mwTestDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(ResolveMiddleware(NewRepository(db)))
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}
