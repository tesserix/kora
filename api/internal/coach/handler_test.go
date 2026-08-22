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

	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/mentor"
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
	r.PUT("/v1/coach/plans/:id/accept", h.AcceptPlan)
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

func TestHandlerAsk_OverlongQuestionReturns400InvalidInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)
	router := newTestRouter(userID, NewHandler(svc))

	payload, err := json.Marshal(askRequest{Question: strings.Repeat("a", maxAskQuestionChars+1)})
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

	provider := &fakeProvider{text: "Your protein target is 120g. [cite:today_protein_g_target]"}
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

// TestHandlerAsk_BudgetExhaustedSerialisesCitationsAsEmptyArrayNotNull pins
// the citations wire format when the budget-exhausted path is taken: the
// upcoming mobile UI maps over the citations array, so a null would crash the
// client. Decoding into a Go []Fact cannot distinguish "[]" from "null" (both
// decode to an empty/nil slice), so this must be a raw-string assertion on the
// response body, not a round-tripped struct comparison — same pattern as
// TestHandlerThread_CitationsSerialiseAsEmptyArrayNotNull.
func TestHandlerAsk_BudgetExhaustedSerialisesCitationsAsEmptyArrayNotNull(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)

	provider := &fakeProvider{text: "should not be reached"}
	svc := NewService(&g, provider, &stubMeter{withinBudget: false}, nil)
	router := newTestRouter(userID, NewHandler(svc))

	payload, err := json.Marshal(askRequest{Question: "how's my protein?"})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/coach/ask", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	raw := w.Body.String()
	require.Contains(t, raw, `"citations":[]`,
		"budget-exhausted response must serialise citations as [], got: %s", raw)
	require.NotContains(t, raw, `"citations":null`,
		"citations must never serialise as null — the mobile client's map() would crash on it, got: %s", raw)
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
		"what should I eat?", "more protein", []Fact{{Label: "Protein today", Value: "65g"}}, Attachments{}))

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

func TestHandlerThread_ReturnsAStoredCommitmentProposal(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)
	proposal, err := mentor.NewCommitmentProposal(userID, time.Now(), time.UTC, mentor.CommitmentProposalDraft{
		Title: "Walk after lunch", Kind: mentor.CommitmentKindWalking,
		Cadence: mentor.CadenceFixed, WeekdaysMask: 127, StartMinute: 13 * 60,
	}, "Kora Meal Planner", "Kora Nutrition Coach")
	require.NoError(t, err)
	require.NoError(t, threadRepo.AppendExchange(t.Context(), userID, "help me walk", "Review this walk", nil, Attachments{Commitment: proposal}))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"proposal":{"id":"`)
	require.Contains(t, w.Body.String(), `"title":"Walk after lunch"`)
	require.Contains(t, w.Body.String(), `"accepted_commitment_id":null`)
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
		"what should I eat?", "an uncited answer", nil, Attachments{}))

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

// TestHandlerAsk_NamesTheAnsweringAgentOnlyWhenOneAnswered pins both halves
// of the attribution contract the chat UI reads: the agent block is present
// with the published display name when an agent answered, and absent — not
// an empty string — when the direct provider did.
func TestHandlerAsk_NamesTheAnsweringAgentOnlyWhenOneAnswered(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackingRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackingRepo, db)
	g := NewGrounder(dashSvc, logRepo, memory.NewService(logRepo), trackingRepo)

	ask := func(svc *Service) string {
		payload, err := json.Marshal(askRequest{Question: "how's my protein?"})
		require.NoError(t, err)
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/coach/ask", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		newTestRouter(userID, NewHandler(svc)).ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
		return w.Body.String()
	}

	runner := &fakeRunner{run: agents.Run{
		Agent:       "nutrition-coach",
		DisplayName: "Nutrition Coach",
		State:       "completed",
		Text:        "You have 55g protein to go.",
	}}
	withAgent := ask(NewService(&g, &fakeProvider{text: "from the provider"}, &stubMeter{withinBudget: true}, nil).WithAgents(runner))
	require.Contains(t, withAgent, `"agent"`)
	require.Contains(t, withAgent, `"name":"Nutrition Coach"`)
	require.Contains(t, withAgent, `"skill":"nutrition-guidance"`)

	withoutAgent := ask(NewService(&g, &fakeProvider{text: "from the provider"}, &stubMeter{withinBudget: true}, nil))
	require.NotContains(t, withoutAgent, `"agent"`)
}

// seedPlanProposal stores one reviewed plan against a fresh turn for userID
// and returns it, so the acceptance tests start from the state Ask leaves
// behind rather than restating how a plan is built.
func seedPlanProposal(t *testing.T, repo ThreadRepository, userID uuid.UUID) PlanProposal {
	t.Helper()
	plan := &PlanProposal{
		Summary: "Hits your 2000 kcal target",
		Days: PlanDays{{Date: "Monday", Meals: []PlanMeal{{
			Name: "Oats and whey", Description: "32g protein",
			Preparation: "Simmer oats, then stir through whey.",
		}}}},
		AgentName:  "Kora Meal Planner",
		ReviewedBy: "Kora Nutrition Coach",
	}
	require.NoError(t, repo.AppendExchange(
		t.Context(), userID, "plan my week", "Here is the week, approve it or tell me what to change.",
		nil, Attachments{Plan: plan},
	))
	return *plan
}

func TestHandlerAcceptPlan_RecordsTheApprovalAndIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	require.NoError(t, db.Exec("UPDATE users SET timezone = ? WHERE id = ?", "Australia/Melbourne", userID).Error)
	threadRepo := NewThreadRepository(db)
	plan := seedPlanProposal(t, threadRepo, userID)

	svc := NewService(&Grounder{}, nil, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	accept := func() PlanProposal {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/v1/coach/plans/"+plan.ID.String()+"/accept", nil))
		require.Equal(t, http.StatusOK, w.Code)
		var body struct {
			Data struct {
				Plan PlanProposal `json:"plan"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		require.NotNil(t, body.Data.Plan.AcceptedAt)
		require.NotNil(t, body.Data.Plan.StartsOn)
		require.Equal(t, "Australia/Melbourne", body.Data.Plan.Timezone)
		return body.Data.Plan
	}

	first := accept()
	second := accept()

	require.True(t, first.AcceptedAt.Equal(*second.AcceptedAt), "a double tap is not a second decision")
	require.True(t, first.StartsOn.Equal(*second.StartsOn), "a retry must not restart the plan")
}

// The id must not be confirmable by anyone it does not belong to, so another
// user's plan is indistinguishable from one that never existed.
func TestHandlerAcceptPlan_AnotherUsersPlanIs404(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, 2000, 120)
	stranger := seedUser(t, db, 2000, 120)
	threadRepo := NewThreadRepository(db)
	plan := seedPlanProposal(t, threadRepo, owner)

	svc := NewService(&Grounder{}, nil, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(stranger, NewHandler(svc))

	for _, path := range []string{
		"/v1/coach/plans/" + plan.ID.String() + "/accept",
		"/v1/coach/plans/" + uuid.NewString() + "/accept",
		"/v1/coach/plans/not-a-uuid/accept",
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodPut, path, nil))
		require.Equal(t, http.StatusNotFound, w.Code, path)
	}

	var unaccepted int
	require.NoError(t, db.Raw(
		`SELECT COUNT(*) FROM coach_plan_proposals WHERE id = ? AND accepted_at IS NULL`, plan.ID,
	).Scan(&unaccepted).Error)
	require.Equal(t, 1, unaccepted, "the owner's plan is untouched")
}

// The thread is what the client replays on cold start, so an approved plan has
// to come back as a card with its decision on it — not as prose the client
// would have to re-parse.
func TestHandlerThread_ReplaysThePlanCard(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)
	seedPlanProposal(t, threadRepo, userID)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"plan":{"id":"`)
	require.Contains(t, w.Body.String(), `"summary":"Hits your 2000 kcal target"`)
	require.Contains(t, w.Body.String(), `"name":"Oats and whey"`)
	require.Contains(t, w.Body.String(), `"accepted_at":null`)
}
