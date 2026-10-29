package onboarding

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
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/tracking"
	"github.com/tesserix/kora/api/internal/user"
)

type planEnv struct {
	r   *gin.Engine
	db  *gorm.DB
	uid uuid.UUID
}

func newPlanEnv(t *testing.T) planEnv {
	t.Helper()
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", fuid) })
	userRepo := user.NewRepository(db)
	_, err := userRepo.UpsertBySubject(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)
	uid, err := userRepo.IDBySubject(t.Context(), fuid)
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := Handler{users: userRepo, weights: tracking.NewRepository(db), now: func() time.Time { return referenceNow(t) }}
	mw := []gin.HandlerFunc{withUID(fuid), user.ResolveMiddleware(userRepo)}
	r.POST("/v1/onboarding", append(mw, h.Submit)...)
	r.GET("/v1/me/plan", append(mw, h.GetPlan)...)
	r.PUT("/v1/me/plan", append(mw, h.PutPlan)...)
	return planEnv{r: r, db: db, uid: uid}
}

func (e planEnv) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	e.r.ServeHTTP(w, req)
	return w
}

func planBody(weight float64, extra string) string {
	b := `{"sex":"male","birth_year":1995,"height_cm":180,"weight_kg":` + strings.TrimRight(strings.TrimRight(
		strings.TrimSpace(string(mustJSON(weight))), "0"), ".") + `,"activity_level":"moderate","goal":"maintenance"`
	if extra != "" {
		b += "," + extra
	}
	return b + "}"
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

type planResp struct {
	Data struct {
		Inputs        Input   `json:"inputs"`
		Targets       Targets `json:"targets"`
		OverrideError *string `json:"override_error"`
	} `json:"data"`
}

func (e planEnv) getPlan(t *testing.T) planResp {
	t.Helper()
	w := e.do(t, http.MethodGet, "/v1/me/plan", "")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var p planResp
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	return p
}

func (e planEnv) addWeighIn(t *testing.T, kg float64) {
	t.Helper()
	_, err := tracking.NewRepository(e.db).AddWeightEntry(t.Context(), e.uid, tracking.WeightInput{
		WeightKg: kg, LoggedAt: referenceNow(t).Add(time.Hour), LocalDate: time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC),
		Composition: tracking.BodyComposition{Source: tracking.SourceManual},
	})
	require.NoError(t, err)
}

func (e planEnv) weighInCount(t *testing.T) int64 {
	t.Helper()
	var n int64
	require.NoError(t, e.db.Model(&tracking.WeightEntry{}).Where("user_id = ?", e.uid).Count(&n).Error)
	return n
}

func TestGetPlanUsesLatestWeighIn(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, "")).Code)
	e.addWeighIn(t, 71)

	p := e.getPlan(t)
	require.Equal(t, 71.0, p.Data.Inputs.WeightKg)
	want, err := Calculate(Input{Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 71,
		ActivityLevel: "moderate", Goal: "maintenance"}, referenceNow(t).Year())
	require.NoError(t, err)
	require.Equal(t, want, p.Data.Targets)
	require.Nil(t, p.Data.OverrideError)
}

func TestGetPlanReturnsOverrideErrorForAnOverrideTheNewWeightInvalidates(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, `"target_protein_override_g":182`)).Code)
	e.addWeighIn(t, 70)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.OverrideError)
	require.Equal(t, "protein_above_max", *p.Data.OverrideError)
	want, err := Calculate(Input{Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 70,
		ActivityLevel: "moderate", Goal: "maintenance"}, referenceNow(t).Year())
	require.NoError(t, err)
	require.Equal(t, want.ProteinG, p.Data.Targets.ProteinG)

	// The stored override is left alone.
	u, err := user.NewRepository(e.db).ByID(t.Context(), e.uid)
	require.NoError(t, err)
	require.NotNil(t, u.TargetProteinOverrideG)
	require.Equal(t, 182.0, *u.TargetProteinOverrideG)
}

func TestGetPlanKeepsValidOverrideWhenOtherFails(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding",
		planBody(73, `"target_kcal_override":2600,"target_protein_override_g":182`)).Code)
	e.addWeighIn(t, 70)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.OverrideError)
	require.Equal(t, 2600.0, p.Data.Targets.Kcal)
}

func TestGetPlanNotOnboarded409(t *testing.T) {
	e := newPlanEnv(t)
	w := e.do(t, http.MethodGet, "/v1/me/plan", "")
	require.Equal(t, http.StatusConflict, w.Code)
	require.Contains(t, w.Body.String(), `"not_onboarded"`)
}

func TestPutPlanNotOnboarded409(t *testing.T) {
	e := newPlanEnv(t)
	w := e.do(t, http.MethodPut, "/v1/me/plan", planBody(73, ""))
	require.Equal(t, http.StatusConflict, w.Code)
	require.Contains(t, w.Body.String(), `"not_onboarded"`)
}

func TestPutPlanSavesWithoutTouchingOnboardedAt(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, "")).Code)
	repo := user.NewRepository(e.db)
	before, err := repo.ByID(t.Context(), e.uid)
	require.NoError(t, err)

	w := e.do(t, http.MethodPut, "/v1/me/plan", planBody(73, `"target_kcal_override":2600`))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	after, err := repo.ByID(t.Context(), e.uid)
	require.NoError(t, err)
	require.NotNil(t, after.TargetKcalOverride)
	require.Equal(t, 2600.0, *after.TargetKcalOverride)
	require.Equal(t, 2600.0, after.TargetKcal)
	require.NotNil(t, after.PlanSavedAt)
	require.True(t, before.OnboardedAt.Equal(*after.OnboardedAt))
}

func TestPutPlanRecordsWeighInOnlyWhenWeightChanged(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, "")).Code)
	require.Equal(t, int64(1), e.weighInCount(t))

	require.Equal(t, 200, e.do(t, "PUT", "/v1/me/plan", planBody(73, "")).Code)
	require.Equal(t, int64(1), e.weighInCount(t))

	require.Equal(t, 200, e.do(t, "PUT", "/v1/me/plan", planBody(72, "")).Code)
	require.Equal(t, int64(2), e.weighInCount(t))
}

func TestPutPlanRejectsInvalidOverride(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, "")).Code)
	w := e.do(t, http.MethodPut, "/v1/me/plan", planBody(73, `"target_protein_override_g":999`))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), `"invalid_override"`)
}
