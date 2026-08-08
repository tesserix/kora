package user

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/bffauth"
)

// adminUsersRouter wires AdminHandler's routes with no auth middleware --
// bffauth is a separate concern already covered by its own middleware tests,
// and the end-to-end signed path is pinned in internal/server.
func adminUsersRouter(h AdminHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// bffauth.Middleware is not mounted here, but the context keys it sets
	// ARE: kora_admin_events has a CHECK constraint rejecting an empty
	// actor_email, so a Delete with no identity in context fails at the
	// database. Setting them is what the real middleware does; the end-to-end
	// proof that it actually does is in internal/server.
	r.Use(func(c *gin.Context) {
		c.Set(bffauth.CtxAdminID, "admin-uid-1")
		c.Set(bffauth.CtxAdminEmail, "admin@tesserix.app")
	})
	r.GET("/v1/admin/users", h.List)
	r.GET("/v1/admin/users/:id", h.Get)
	r.DELETE("/v1/admin/users/:id", h.Delete)
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

// TestAdminHandlerGetReturnsCountsNotContent is the privacy assertion for the
// detail view: an operator gets NUMBERS, never a user's actual food logs, and
// never a body metric, target value, firebase uid or Apple refresh token.
// Scoped to one seeded user; nothing here reads a global total.
func TestAdminHandlerGetReturnsCountsNotContent(t *testing.T) {
	db := testDB(t)
	u := seedUser(t, db)
	seedFoodLog(t, db, u.ID)
	seedWeightEntry(t, db, u.ID)

	h := NewAdminHandler(NewRepository(db), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/admin/users/"+u.ID.String(), nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	body := w.Body.String()
	assert.NotContains(t, body, "firebase_uid")
	assert.NotContains(t, body, "apple_refresh_token")
	assert.NotContains(t, body, "target_kcal", "target VALUES must never leave the API")
	assert.NotContains(t, body, "weight_kg", "body metrics must never leave the API")
	assert.NotContains(t, body, "test log", "the detail view is counts only, never a user's meals")

	var parsed struct {
		Data AdminDetail `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))
	assert.Equal(t, u.ID, parsed.Data.ID)
	assert.Equal(t, int64(1), parsed.Data.Counts["food_logs"])
	assert.Equal(t, int64(1), parsed.Data.Counts["weight_entries"])
	assert.False(t, parsed.Data.HasAppleToken)
}

func TestAdminHandlerGetMalformedIDIs400(t *testing.T) {
	h := NewAdminHandler(NewRepository(&gorm.DB{}), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/admin/users/not-a-uuid", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"id must be a UUID"}`, w.Body.String())
}

func TestAdminHandlerGetUnknownIs404(t *testing.T) {
	db := testDB(t)
	h := NewAdminHandler(NewRepository(db), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/admin/users/"+uuid.NewString(), nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
	assert.JSONEq(t, `{"error":"not_found","message":"user not found"}`, w.Body.String())
}

// TestAdminDeleteReportsFirebaseSurvival pins the 200-with-body divergence
// from DELETE /v1/me's bare 204. If the Firebase identity survives, the user
// can sign in, EnsureUser provisions a fresh row, and the person the admin
// deleted REAPPEARS. A self-deleting user retries; an admin cannot, so the
// admin must be told in the response body.
func TestAdminDeleteReportsFirebaseSurvival(t *testing.T) {
	db := testDB(t)
	u := seedUser(t, db)
	cleanupAdminEvents(t, db, u.ID)

	h := NewAdminHandler(NewRepository(db), newTestServiceWithFailingFirebase(t, db))
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodDelete, "/v1/admin/users/"+u.ID.String(), nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), `"firebase_identity_removed":false`)

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, u.ID).Scan(&n).Error)
	assert.Zero(t, n, "the row must actually be gone despite the Firebase failure")
}

func TestAdminDeleteUnknownIs404(t *testing.T) {
	db := testDB(t)
	h := NewAdminHandler(NewRepository(db), newTestService(t, db))
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodDelete, "/v1/admin/users/"+uuid.NewString(), nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
	assert.JSONEq(t, `{"error":"not_found","message":"user not found"}`, w.Body.String())
}

func TestAdminDeleteMalformedIDIs400(t *testing.T) {
	h := NewAdminHandler(NewRepository(&gorm.DB{}), Service{})
	r := adminUsersRouter(h)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodDelete, "/v1/admin/users/not-a-uuid", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"id must be a UUID"}`, w.Body.String())
}
