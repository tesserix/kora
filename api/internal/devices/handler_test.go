package devices

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	h := NewHandler(NewRepository(db))
	r.POST("/v1/devices", h.Register)
	r.DELETE("/v1/devices/:token", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestRegisterDevice(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)

	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.Equal(t, http.StatusOK, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"`+tok+`","platform":"ios"}`).Code)

	// blank token → 400
	require.Equal(t, http.StatusBadRequest, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"","platform":"ios"}`).Code)
	// bad platform → 400
	require.Equal(t, http.StatusBadRequest, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"t","platform":"windows"}`).Code)
}

func TestDeleteDevice(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)
	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, NewRepository(db).Upsert(t.Context(), me, tok, "ios"))
	// URL-encode the bracketed token in the path segment
	require.Equal(t, http.StatusOK, doJSON(r, http.MethodDelete, "/v1/devices/"+"ExponentPushToken%5Btest%5D", "").Code)
}

func TestRegisterUnauthorized(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New() // no user_id middleware
	h := NewHandler(NewRepository(db))
	r.POST("/v1/devices", h.Register)
	require.Equal(t, http.StatusUnauthorized, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"t","platform":"ios"}`).Code)
}
