package coach

import (
	"bytes"
	"context"
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
	r.GET("/v1/coach/thread", h.Thread)
	return r
}

func TestHandlerNudges_Returns200WithNudges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)
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

func TestHandlerNudges_ResponseIncludesKindAndTitle(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/nudges", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Nudges []Nudge `json:"nudges"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Nudges,
		"a fresh user with a protein target and no logs should get a protein-gap nudge")

	first := body.Data.Nudges[0]
	require.Equal(t, NudgeKindProtein, first.Kind)
	require.Equal(t, "Protein", first.Title)
	require.NotEmpty(t, first.Text)

	// Assert the raw wire keys: round-tripping through Go types above would
	// pass regardless of JSON casing, so this is what actually pins the
	// snake_case contract the mobile client codes against.
	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"kind"`), "raw body should contain \"kind\", got: %s", raw)
	require.True(t, strings.Contains(raw, `"title"`), "raw body should contain \"title\", got: %s", raw)
	require.False(t, strings.Contains(raw, `"Kind"`), "raw body should not contain PascalCase \"Kind\", got: %s", raw)
	require.False(t, strings.Contains(raw, `"Title"`), "raw body should not contain PascalCase \"Title\", got: %s", raw)
}

func TestHandlerAsk_EmptyQuestionReturns400InvalidInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)
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
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)

	provider := &fakeProvider{text: "You have protein remaining today."}
	svc := NewService(&g, provider, &stubMeter{withinBudget: true}, nil)
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

func TestHandlerThread_ReturnsStoredTurnsWithSnakeCaseKeys(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"what should I eat?", "more protein", []Fact{{Label: "Protein today", Value: "65g"}}))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Turns []struct {
				Role      string `json:"role"`
				Text      string `json:"text"`
				Citations []struct {
					Label string `json:"label"`
					Value string `json:"value"`
				} `json:"citations"`
			} `json:"turns"`
			ShowSupport bool `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.Turns, 2)
	require.Equal(t, "user", body.Data.Turns[0].Role)
	require.Equal(t, "otto", body.Data.Turns[1].Role)
	require.Len(t, body.Data.Turns[1].Citations, 1)
	require.Equal(t, "Protein today", body.Data.Turns[1].Citations[0].Label)

	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"show_support"`), "raw body must use snake_case show_support, got: %s", raw)
	require.True(t, strings.Contains(raw, `"created_at"`), "raw body must use snake_case created_at, got: %s", raw)
	require.False(t, strings.Contains(raw, `"showSupport"`), "raw body must not use camelCase, got: %s", raw)
}

// TestHandlerThread_CitationsSerialiseAsEmptyArrayNotNull pins the per-turn
// citations wire format: the upcoming mobile UI maps over this array, so a
// null would crash the client. Decoding into a Go []Fact cannot distinguish
// "[]" from "null" (both decode to an empty/nil slice), so this must be a
// raw-string assertion on the response body, not a round-tripped struct
// comparison — see TestHandlerThread_ReturnsStoredTurnsWithSnakeCaseKeys and
// TestHandlerThread_EmptyThreadReturnsEmptyList for the same pattern applied
// to the outer keys and the outer empty turns array respectively.
func TestHandlerThread_CitationsSerialiseAsEmptyArrayNotNull(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	// nil citations: the stored answer cited nothing.
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"what should I eat?", "an uncited answer", nil))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	raw := w.Body.String()
	require.Contains(t, raw, `"citations":[]`,
		"a turn with no citations must serialise citations as [], got: %s", raw)
	require.NotContains(t, raw, `"citations":null`,
		"citations must never serialise as null — the mobile client's map() would crash on it, got: %s", raw)
}

func TestHandlerThread_EmptyThreadReturnsEmptyList(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	// turns must serialise as [] not null, so the client can map over it.
	require.Contains(t, w.Body.String(), `"turns":[]`)
}
