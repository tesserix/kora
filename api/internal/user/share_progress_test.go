package user

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func spTestDB(t *testing.T) *gorm.DB {
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

func TestUpdateShareProgressTogglesAndPersists(t *testing.T) {
	db := spTestDB(t)
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "sp-"+id.String(), "sp@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", id); c.Next() })
	h := NewHandler(NewRepository(db))
	r.PATCH("/v1/me/share-progress", h.UpdateShareProgress)

	req := httptest.NewRequest(http.MethodPatch, "/v1/me/share-progress", strings.NewReader(`{"share_progress":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			ShareProgress bool `json:"share_progress"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.True(t, body.Data.ShareProgress)

	// persisted
	u, err := NewRepository(db).ByID(context.Background(), id)
	require.NoError(t, err)
	require.True(t, u.ShareProgress)
}
