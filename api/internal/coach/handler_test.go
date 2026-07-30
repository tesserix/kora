package coach

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/tracking"
)

// newTestRouter wires h's endpoints behind fake-auth middleware that sets the
// exact context keys user.IDFromContext/user.LocFromContext read
// ("user_id"/"user_loc"), bypassing user.ResolveMiddleware entirely — the
// same idiom used across the other handler tests in this repo.
func newTestRouter(userID uuid.UUID, h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("user_id", userID)
		c.Set("user_loc", time.UTC)
		c.Next()
	})
	r.GET("/v1/coach/nudges", h.Nudges)
	r.POST("/v1/coach/ask", h.Ask)
	return r
}

func TestHandlerNudges_Returns200WithNudges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true})
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/nudges", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Nudges      []Nudge `json:"nudges"`
			ShowSupport bool    `json:"showSupport"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Nudges, "a fresh user with no logs should still get a protein-gap nudge")

	// Round-tripping through the Go types above passes regardless of JSON
	// casing, so assert the raw wire body directly to catch a PascalCase
	// regression in the snake_case API contract.
	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"text"`), "raw body should contain snake_case %q key, got: %s", "text", raw)
	require.True(t, strings.Contains(raw, `"show_support"`), "raw body should contain snake_case %q key, got: %s", "show_support", raw)
	require.False(t, strings.Contains(raw, `"Text"`), "raw body should not contain PascalCase %q key, got: %s", "Text", raw)
	require.False(t, strings.Contains(raw, `"showSupport"`), "raw body should not contain camelCase %q key, got: %s", "showSupport", raw)
}

func TestHandlerAsk_EmptyQuestionReturns400InvalidInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true})
	router := newTestRouter(userID, NewHandler(svc))

	payload, err := json.Marshal(askRequest{Question: ""})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/coach/ask", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)
}

func TestHandlerAsk_RealQuestionReturns200WithAnswerAndCitations(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	provider := &fakeProvider{text: "You have protein remaining today."}
	svc := NewService(&g, provider, &stubMeter{withinBudget: true})
	router := newTestRouter(userID, NewHandler(svc))

	payload, err := json.Marshal(askRequest{Question: "how's my protein?"})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/coach/ask", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Answer      string `json:"answer"`
			Citations   []Fact `json:"citations"`
			ShowSupport bool   `json:"showSupport"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Answer)
	require.NotEmpty(t, body.Data.Citations)

	// Round-tripping through the Go types above passes regardless of JSON
	// casing, so assert the raw wire body directly to catch a PascalCase
	// regression in the snake_case API contract.
	raw := w.Body.String()
	for _, key := range []string{`"answer"`, `"citations"`, `"label"`, `"value"`, `"show_support"`} {
		require.True(t, strings.Contains(raw, key), "raw body should contain snake_case %q, got: %s", key, raw)
	}
	require.False(t, strings.Contains(raw, `"showSupport"`), "raw body should not contain camelCase %q key, got: %s", "showSupport", raw)
	require.False(t, strings.Contains(raw, `"Label"`), "raw body should not contain PascalCase %q key, got: %s", "Label", raw)
	require.False(t, strings.Contains(raw, `"Value"`), "raw body should not contain PascalCase %q key, got: %s", "Value", raw)
}
