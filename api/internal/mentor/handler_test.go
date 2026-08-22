package mentor

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
)

func mentorRouter(userID uuid.UUID, h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if userID != uuid.Nil {
		r.Use(func(c *gin.Context) {
			c.Set("user_id", userID)
			c.Next()
		})
	}
	r.GET("/v1/mentor/profile", h.GetProfile)
	r.PUT("/v1/mentor/profile", h.PutProfile)
	r.GET("/v1/mentor/health/days", h.ListHealthDays)
	r.PUT("/v1/mentor/health/days", h.PutHealthDays)
	r.DELETE("/v1/mentor/health/days", h.DeleteHealthDays)
	r.GET("/v1/mentor/commitments", h.ListCommitments)
	r.PUT("/v1/mentor/commitments/:id", h.PutCommitment)
	r.PUT("/v1/mentor/commitments/:id/check-ins", h.PutCheckIn)
	r.PUT("/v1/mentor/proposals/:id/accept", h.AcceptProposal)
	return r
}

func TestHandlerAcceptProposalIsOwnerScopedExplicitAndIdempotent(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	turnID := uuid.New()
	require.NoError(t, db.Exec(`
		INSERT INTO coach_turns (id, user_id, role, text)
		VALUES (?, ?, 'otto', 'Review this commitment')`, turnID, owner).Error)
	proposal, err := NewCommitmentProposal(owner, time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC), time.UTC, CommitmentProposalDraft{
		Title: "Walk after lunch", Kind: CommitmentKindWalking,
		Cadence: CadenceFixed, WeekdaysMask: 127, StartMinute: 13 * 60,
	}, "Kora Meal Planner", "Kora Nutrition Coach")
	require.NoError(t, err)
	proposal.CoachTurnID = turnID
	require.NoError(t, db.Create(proposal).Error)

	commitmentID := uuid.New()
	body := map[string]any{
		"commitment_id": commitmentID,
		"title":         "Walk after lunch", "kind": CommitmentKindWalking,
		"cadence": CadenceFixed, "weekdays_mask": 62,
		"start_minute": 13 * 60, "interval_minutes": nil, "end_minute": nil,
		"timezone": "UTC", "starts_on": "2026-08-22", "ends_on": nil,
	}
	ownerRouter := mentorRouter(owner, NewHandler(NewService(NewRepository(db))))
	w := serveJSON(ownerRouter, http.MethodPut, "/v1/mentor/proposals/"+proposal.ID.String()+"/accept", body)
	require.Equal(t, http.StatusOK, w.Code)
	var accepted struct {
		Data Commitment `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &accepted))
	require.Equal(t, commitmentID, accepted.Data.ID)
	require.Equal(t, CommitmentSourceMealPlanner, accepted.Data.Source)
	require.NotNil(t, accepted.Data.AgentName)
	require.Equal(t, "Kora Meal Planner", *accepted.Data.AgentName)

	pauseBody := map[string]any{
		"title": "Walk after lunch", "kind": CommitmentKindWalking,
		"cadence": CadenceFixed, "weekdays_mask": 62,
		"start_minute": 13 * 60, "interval_minutes": nil, "end_minute": nil,
		"timezone": "UTC", "starts_on": "2026-08-22", "ends_on": nil,
		"status": CommitmentStatusPaused,
	}
	w = serveJSON(ownerRouter, http.MethodPut, "/v1/mentor/commitments/"+commitmentID.String(), pauseBody)
	require.Equal(t, http.StatusOK, w.Code)
	var paused struct {
		Data Commitment `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &paused))
	require.Equal(t, CommitmentSourceMealPlanner, paused.Data.Source, "user edits must not erase agent provenance")
	require.NotNil(t, paused.Data.AgentName)

	body["commitment_id"] = uuid.New()
	w = serveJSON(ownerRouter, http.MethodPut, "/v1/mentor/proposals/"+proposal.ID.String()+"/accept", body)
	require.Equal(t, http.StatusOK, w.Code)
	var retried struct {
		Data Commitment `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &retried))
	require.Equal(t, commitmentID, retried.Data.ID, "a retry must return the first accepted commitment")

	otherRouter := mentorRouter(other, NewHandler(NewService(NewRepository(db))))
	w = serveJSON(otherRouter, http.MethodPut, "/v1/mentor/proposals/"+proposal.ID.String()+"/accept", body)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func serveJSON(r http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestHandlerRequiresAuthenticatedUserForMentorData(t *testing.T) {
	h := NewHandler(NewService(NewRepository(mentorTestDB(t))))
	r := mentorRouter(uuid.Nil, h)

	for _, request := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/v1/mentor/profile"},
		{http.MethodPut, "/v1/mentor/health/days"},
		{http.MethodGet, "/v1/mentor/commitments"},
	} {
		w := serveJSON(r, request.method, request.path, map[string]any{})
		require.Equal(t, http.StatusUnauthorized, w.Code)
		require.JSONEq(t, `{"error":"unauthorized","message":"invalid or missing token"}`, w.Body.String())
	}
}

func TestHandlerRejectsOversizedMentorBodyBeforeDecoding(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	r := mentorRouter(owner, NewHandler(NewService(NewRepository(db))))

	w := serveJSON(r, http.MethodPut, "/v1/mentor/profile", map[string]any{
		"motivation": strings.Repeat("a", 70*1024),
	})

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.JSONEq(t, `{"error":"invalid_input","message":"malformed mentor profile"}`, w.Body.String())
}

func TestHandlerProfileDefaultsThenPersistsConfirmedPreferences(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	h := NewHandler(NewService(NewRepository(db)))
	r := mentorRouter(owner, h)

	w := serveJSON(r, http.MethodGet, "/v1/mentor/profile", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var initial struct {
		Data Profile `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &initial))
	require.Equal(t, CoachingStyleSupportive, initial.Data.CoachingStyle)
	require.Equal(t, ReminderIntensityBalanced, initial.Data.ReminderIntensity)

	w = serveJSON(r, http.MethodPut, "/v1/mentor/profile", map[string]any{
		"motivation":              "Keep up with my children",
		"dietary_preferences":     "Vegetarian weekdays",
		"allergies":               "Peanuts",
		"coaching_style":          CoachingStyleEducational,
		"reminder_intensity":      ReminderIntensityLight,
		"quiet_start_minute":      21 * 60,
		"quiet_end_minute":        7 * 60,
		"health_steps_enabled":    true,
		"health_sleep_enabled":    true,
		"health_workouts_enabled": false,
	})
	require.Equal(t, http.StatusOK, w.Code)
	var saved struct {
		Data Profile `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &saved))
	require.Equal(t, "Keep up with my children", saved.Data.Motivation)
	require.NotNil(t, saved.Data.ConfirmedAt)

	w = serveJSON(r, http.MethodPut, "/v1/mentor/profile", map[string]any{
		"coaching_style":     "punishing",
		"reminder_intensity": ReminderIntensityBalanced,
		"quiet_start_minute": 0,
		"quiet_end_minute":   0,
	})
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHandlerHealthDaysAreIdempotentAndRevocable(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	h := NewHandler(NewService(NewRepository(db)))
	r := mentorRouter(owner, h)
	day := "2026-08-22"
	observed := time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)

	put := func(steps int) *httptest.ResponseRecorder {
		return serveJSON(r, http.MethodPut, "/v1/mentor/health/days", map[string]any{
			"days": []map[string]any{{
				"local_date": day, "timezone": "Australia/Melbourne", "steps": steps,
				"observed_at": observed,
			}},
		})
	}
	require.Equal(t, http.StatusOK, put(4000).Code)
	require.Equal(t, http.StatusOK, put(6500).Code)

	w := serveJSON(r, http.MethodGet, "/v1/mentor/health/days?from=2026-08-20", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var listed struct {
		Data []HealthDay `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Data, 1)
	require.Equal(t, 6500, *listed.Data[0].Steps)

	w = serveJSON(r, http.MethodPut, "/v1/mentor/health/days", map[string]any{
		"days": []map[string]any{{
			"local_date": day, "timezone": "Australia/Melbourne", "observed_at": observed,
		}},
	})
	require.Equal(t, http.StatusBadRequest, w.Code, "absence of Health data must not become a measured zero")

	w = serveJSON(r, http.MethodDelete, "/v1/mentor/health/days", nil)
	require.Equal(t, http.StatusNoContent, w.Code)
	w = serveJSON(r, http.MethodGet, "/v1/mentor/health/days?from=2026-08-20", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"data":[]}`, w.Body.String())
}

func TestHandlerAnotherUsersCommitmentAndCheckInAre404(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	repo := NewRepository(db)
	id := uuid.New()
	_, err := repo.PutCommitment(t.Context(), Commitment{
		ID: id, UserID: owner, Title: "Walk after work", Kind: CommitmentKindWalking,
		Cadence: CadenceFixed, WeekdaysMask: 127, StartMinute: 18 * 60,
		Timezone: "Australia/Melbourne", StartsOn: time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC),
		Status: CommitmentStatusActive, Source: CommitmentSourceUser,
	})
	require.NoError(t, err)
	r := mentorRouter(other, NewHandler(NewService(repo)))

	w := serveJSON(r, http.MethodPut, "/v1/mentor/commitments/"+id.String(), map[string]any{
		"title": "Hijacked", "kind": CommitmentKindWalking, "cadence": CadenceFixed,
		"weekdays_mask": 127, "start_minute": 600, "timezone": "Australia/Melbourne",
		"starts_on": "2026-08-22", "status": CommitmentStatusActive,
	})
	require.Equal(t, http.StatusNotFound, w.Code)

	w = serveJSON(r, http.MethodPut, "/v1/mentor/commitments/"+id.String()+"/check-ins", map[string]any{
		"scheduled_for": "2026-08-23T08:00:00Z", "local_date": "2026-08-23",
		"action": CheckInActionDone,
	})
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestHandlerCreatesListsPausesAndChecksInCommitment(t *testing.T) {
	db := mentorTestDB(t)
	owner := seedMentorUser(t, db)
	r := mentorRouter(owner, NewHandler(NewService(NewRepository(db))))
	id := uuid.New()
	path := "/v1/mentor/commitments/" + id.String()
	body := map[string]any{
		"title": "Drink water", "kind": CommitmentKindHydration, "cadence": CadenceInterval,
		"weekdays_mask": 127, "start_minute": 480, "interval_minutes": 120,
		"end_minute": 1200, "timezone": "Australia/Melbourne",
		"starts_on": "2026-08-22", "status": CommitmentStatusActive,
	}
	w := serveJSON(r, http.MethodPut, path, body)
	require.Equal(t, http.StatusOK, w.Code)

	w = serveJSON(r, http.MethodGet, "/v1/mentor/commitments", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var listed struct {
		Data []Commitment `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listed))
	require.Len(t, listed.Data, 1)
	require.Equal(t, CommitmentSourceUser, listed.Data[0].Source, "the client must not choose trusted agent provenance")

	w = serveJSON(r, http.MethodPut, path+"/check-ins", map[string]any{
		"scheduled_for": "2026-08-23T08:00:00Z", "local_date": "2026-08-23",
		"action": CheckInActionSnoozed, "snoozed_until": "2026-08-23T08:30:00Z",
	})
	require.Equal(t, http.StatusOK, w.Code)

	body["status"] = CommitmentStatusPaused
	w = serveJSON(r, http.MethodPut, path, body)
	require.Equal(t, http.StatusOK, w.Code)
	var paused struct {
		Data Commitment `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &paused))
	require.Equal(t, CommitmentStatusPaused, paused.Data.Status)
}
