package feedback

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// newTestRouter wires h's Create endpoint behind fake-auth middleware that
// sets the exact context key user.IDFromContext reads ("user_id"), bypassing
// user.ResolveMiddleware entirely — the same idiom used in
// coach/handler_test.go. When authenticated is false, no middleware sets
// user_id, exercising the unauthenticated path.
func newTestRouter(userID uuid.UUID, h Handler, authenticated bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if authenticated {
		r.Use(func(c *gin.Context) {
			c.Set("user_id", userID)
			c.Next()
		})
	}
	r.POST("/v1/feedback", h.Create)
	return r
}

func validPayload() map[string]any {
	return map[string]any{
		"kind":         "bug",
		"subject":      "Camera freezes on capture",
		"description":  "Tapping the shutter freezes the app for ~5s.",
		"app_version":  "1.0.0",
		"platform":     "ios",
		"os_version":   "26.1",
		"device_model": "iPhone17,2",
	}
}

func doCreate(router *gin.Engine, payload map[string]any) *httptest.ResponseRecorder {
	body, _ := json.Marshal(payload)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/feedback", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

func TestHandlerCreate_StoresFeedbackAndReturnsID(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	router := newTestRouter(userID, NewHandler(repo), true)

	w := doCreate(router, validPayload())

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.ID)
	require.Equal(t, "open", body.Data.Status)

	// Assert the raw wire keys directly: round-tripping through the Go types
	// above passes regardless of JSON casing.
	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"id"`), "raw body should contain snake_case \"id\", got: %s", raw)
	require.True(t, strings.Contains(raw, `"status"`), "raw body should contain snake_case \"status\", got: %s", raw)

	id, err := uuid.Parse(body.Data.ID)
	require.NoError(t, err)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", id).Error)
	require.Equal(t, userID, got.UserID)
	require.Equal(t, KindBug, got.Kind)
	require.Equal(t, "Camera freezes on capture", got.Subject)
	require.Equal(t, "Tapping the shutter freezes the app for ~5s.", got.Description)
	require.Equal(t, StatusOpen, got.Status)
	require.Equal(t, "1.0.0", got.AppVersion)
	require.Equal(t, "ios", got.Platform)
	require.Equal(t, "26.1", got.OSVersion)
	require.Equal(t, "iPhone17,2", got.DeviceModel)
}

func TestHandlerCreate_RejectsUnknownKind(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	router := newTestRouter(userID, NewHandler(repo), true)

	payload := validPayload()
	payload["kind"] = "spam"
	w := doCreate(router, payload)

	require.Equal(t, http.StatusBadRequest, w.Code)
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)
}

func TestHandlerCreate_RejectsEmptySubject(t *testing.T) {
	for _, subject := range []string{"", "   "} {
		t.Run(fmt.Sprintf("subject=%q", subject), func(t *testing.T) {
			db := testDB(t)
			userID := seedUser(t, db)
			repo := NewRepository(db)
			router := newTestRouter(userID, NewHandler(repo), true)

			payload := validPayload()
			payload["subject"] = subject
			w := doCreate(router, payload)

			require.Equal(t, http.StatusBadRequest, w.Code)
			var body struct {
				Error string `json:"error"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			require.Equal(t, "invalid_input", body.Error)
		})
	}
}

func TestHandlerCreate_RejectsEmptyDescription(t *testing.T) {
	for _, feedbackDescription := range []string{"", "   "} {
		t.Run(fmt.Sprintf("description=%q", feedbackDescription), func(t *testing.T) {
			db := testDB(t)
			userID := seedUser(t, db)
			repo := NewRepository(db)
			router := newTestRouter(userID, NewHandler(repo), true)

			payload := validPayload()
			payload["description"] = feedbackDescription
			w := doCreate(router, payload)

			require.Equal(t, http.StatusBadRequest, w.Code)
			var body struct {
				Error string `json:"error"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			require.Equal(t, "invalid_input", body.Error)
		})
	}
}

func TestHandlerCreate_RejectsOverlongSubject(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	router := newTestRouter(userID, NewHandler(repo), true)

	payload := validPayload()
	payload["subject"] = strings.Repeat("a", maxSubjectChars+1)
	w := doCreate(router, payload)

	require.Equal(t, http.StatusBadRequest, w.Code, "must reject, not 500, and not silently truncate")
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)

	var count int64
	require.NoError(t, db.Model(&Feedback{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Zero(t, count, "an over-length subject must not be stored, truncated or otherwise")
}

func TestHandlerCreate_RejectsOverlongDescription(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	router := newTestRouter(userID, NewHandler(repo), true)

	payload := validPayload()
	payload["description"] = strings.Repeat("a", maxDescriptionChars+1)
	w := doCreate(router, payload)

	require.Equal(t, http.StatusBadRequest, w.Code, "must reject, not 500, and not silently truncate")
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)

	var count int64
	require.NoError(t, db.Model(&Feedback{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Zero(t, count, "an over-length description must not be stored, truncated or otherwise")
}

// TestHandlerCreate_IgnoresUserIDInBody is the security-critical case: the
// reporter must come from the auth context only. This posts a body carrying
// a *different* user's id and asserts the stored row's user_id is the
// authenticated caller's — it would fail if the handler ever read the
// reporter from the request body instead of user.IDFromContext.
func TestHandlerCreate_IgnoresUserIDInBody(t *testing.T) {
	db := testDB(t)
	authenticatedUserID := seedUser(t, db)
	impersonatedUserID := seedUser(t, db)
	require.NotEqual(t, authenticatedUserID, impersonatedUserID)

	repo := NewRepository(db)
	router := newTestRouter(authenticatedUserID, NewHandler(repo), true)

	payload := validPayload()
	payload["user_id"] = impersonatedUserID.String()
	w := doCreate(router, payload)

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	id, err := uuid.Parse(body.Data.ID)
	require.NoError(t, err)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", id).Error)
	require.Equal(t, authenticatedUserID, got.UserID,
		"the reporter must be taken from the auth context, never the request body")
	require.NotEqual(t, impersonatedUserID, got.UserID)
}

func TestHandlerCreate_Unauthenticated(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := newTestRouter(uuid.Nil, NewHandler(repo), false)

	w := doCreate(router, validPayload())

	require.Equal(t, http.StatusUnauthorized, w.Code)
}
