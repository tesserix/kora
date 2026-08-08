package user

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// adminUsersRouter wires AdminHandler's List route with no auth middleware --
// bffauth is a separate concern already covered by its own middleware tests.
func adminUsersRouter(h AdminHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/users", h.List)
	return r
}

// TestAdminHandlerListReturnsEnvelope checks the handler wraps
// Repository.ListForAdmin's result in the {"data": ...} envelope and never
// leaks firebase_uid. It seeds one user into the shared database and looks
// it up in the response body by id -- the response's item COUNT is ambient
// (shared DB), so only the presence and shape of this one seeded user's
// fields are asserted, never a total or a fixed index.
func TestAdminHandlerListReturnsEnvelope(t *testing.T) {
	db := testDB(t)
	u := seedUser(t, db)
	seedFoodLog(t, db, u.ID)
	seedAIUsageEvent(t, db, u.ID)

	h := NewAdminHandler(NewRepository(db), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/admin/users", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	body := w.Body.String()
	// Check for the JSON KEY, not u.FirebaseUID's value: seedUser derives the
	// email from the firebase uid (fuid+"@test.dev"), so the value itself is
	// a substring of the email already asserted on below -- that would make
	// this assertion pass for the wrong reason.
	assert.NotContains(t, body, "firebase_uid", "firebase_uid must never be serialised")
	assert.NotContains(t, body, "apple_refresh_token")

	var parsed struct {
		Data AdminListResult `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))

	found := false
	for _, row := range parsed.Data.Items {
		if row.ID == u.ID {
			found = true
			assert.Equal(t, int64(1), row.LogCount)
			assert.Equal(t, int64(1), row.AICalls)
			assert.Equal(t, u.Email, row.Email)
		}
	}
	assert.True(t, found, "seeded user must appear in the admin list")
}

// TestAdminHandlerListInternalErrorUsesHttpxError proves errors from the
// repository go through httpx.Error rather than a raw c.JSON, by using a
// closed DB connection to force ListForAdmin to fail.
func TestAdminHandlerListInternalErrorUsesHttpxError(t *testing.T) {
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())

	h := NewAdminHandler(NewRepository(db), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/admin/users", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusInternalServerError, w.Code)
	assert.JSONEq(t, `{"error":"internal_error","message":"something went wrong"}`, w.Body.String())
}
