package compare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

type stubFriends struct{ rows []social.CompareRow }

func (s stubFriends) ListAcceptedForCompare(context.Context, uuid.UUID) ([]social.CompareRow, error) {
	return s.rows, nil
}

type stubUsers struct{ target float64 }

func (s stubUsers) ByID(context.Context, uuid.UUID) (user.User, error) {
	return user.User{TargetKcal: s.target}, nil
}

type stubLogs struct{}

func (stubLogs) LoggedDaysDesc(context.Context, uuid.UUID, time.Time, *time.Location, int) ([]string, error) {
	return []string{}, nil
}
func (stubLogs) DailyKcal(context.Context, uuid.UUID, time.Time, time.Time, *time.Location) (map[string]float64, error) {
	return map[string]float64{}, nil
}

func TestCompareGatesNonSharingFriends(t *testing.T) {
	sharerID := uuid.New()
	privateID := uuid.New()
	svc := NewService(
		stubFriends{rows: []social.CompareRow{
			{ID: sharerID, DisplayName: "Sharer", ShareProgress: true, TargetKcal: 2000},
			{ID: privateID, DisplayName: "Private", ShareProgress: false, TargetKcal: 2000},
		}},
		stubUsers{target: 2000},
		stubLogs{},
	)
	res, err := svc.Compare(context.Background(), uuid.New(), time.Now(), time.UTC)
	require.NoError(t, err)
	require.Len(t, res.Friends, 2)

	byName := map[string]FriendProgress{}
	for _, f := range res.Friends {
		byName[f.DisplayName] = f
	}
	require.True(t, byName["Sharer"].Sharing)
	require.NotNil(t, byName["Sharer"].StreakDays) // metrics present for sharer
	require.False(t, byName["Private"].Sharing)
	require.Nil(t, byName["Private"].StreakDays) // NEVER computed for non-sharer
	require.Nil(t, byName["Private"].AdherenceDays)
}

func TestCompareHandlerShape(t *testing.T) {
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, stubLogs{})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() })
	r.GET("/v1/friends/progress", NewHandler(svc).Get)

	req := httptest.NewRequest(http.MethodGet, "/v1/friends/progress", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Me struct {
				AdherenceWindow int `json:"adherence_window"`
			} `json:"me"`
			Friends []any `json:"friends"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, 7, body.Data.Me.AdherenceWindow)
}
