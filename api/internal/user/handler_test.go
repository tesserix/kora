package user

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
)

type staticVerifier struct{ claims auth.Claims }

func (s staticVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return s.claims, nil
}

func testDB(t *testing.T) *gorm.DB {
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

func TestMeCreatesUserOnFirstCall(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-me") })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: "test-uid-me", Email: "me@test.dev"}}
	h := NewHandler(NewRepository(db))
	r.GET("/v1/me", auth.Middleware(v), h.Me)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"email":"me@test.dev"`)

	var count int64
	db.Model(&User{}).Where("firebase_uid = ?", "test-uid-me").Count(&count)
	assert.Equal(t, int64(1), count)
}
