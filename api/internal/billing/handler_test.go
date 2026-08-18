package billing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

func TestUsageStatusReturnsTheResolvedUsersQuotaOnly(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	day := quotaWindowsAt(now)[0]
	setQuotaCount(t, db, userID, quotaDay, day.start, 6)

	var firebaseUID string
	require.NoError(t, db.Raw("SELECT firebase_uid FROM users WHERE id = ?", userID).Scan(&firebaseUID).Error)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set("uid", firebaseUID)
		c.Next()
	})
	router.Use(user.ResolveMiddleware(user.NewRepository(db)))
	handler := NewHandler(meter)
	router.GET("/v1/ai/usage", handler.UsageStatus)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/ai/usage", nil))

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Daily WindowStatus `json:"daily"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, 6, body.Data.Daily.Used)
	require.Equal(t, perUserDailyRequestCap-6, body.Data.Daily.Remaining)
}
