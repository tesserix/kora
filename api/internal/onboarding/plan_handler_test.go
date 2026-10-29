package onboarding

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
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
	b := `{"sex":"male","birth_year":1995,"height_cm":180,"weight_kg":` + strconv.FormatFloat(weight, 'f', -1, 64) +
		`,"activity_level":"moderate","goal":"maintenance"`
	if extra != "" {
		b += "," + extra
	}
	return b + "}"
}

type planResp struct {
	Data struct {
		Inputs        Input   `json:"inputs"`
		Targets       Targets `json:"targets"`
		OverrideError *string `json:"override_error"`
		InputError    *string `json:"input_error"`
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
	require.Equal(t, "protein_above_max", *p.Data.OverrideError)
	require.Equal(t, 2600.0, p.Data.Targets.Kcal)
	want, err := Calculate(Input{Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 70,
		ActivityLevel: "moderate", Goal: "maintenance"}, referenceNow(t).Year())
	require.NoError(t, err)
	require.Equal(t, want.ProteinG, p.Data.Targets.ProteinG)
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

func TestGetPlanSurvivesReachedGoal(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding",
		strings.Replace(planBody(73, `"goal_weight_kg":70,"pace_kg_per_week":0.5`), `"maintenance"`, `"fat_loss"`, 1)).Code)
	e.addWeighIn(t, 69.5)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.InputError)
	require.NotZero(t, p.Data.Targets.Kcal)
	require.Equal(t, 69.5, p.Data.Inputs.WeightKg)
	require.Equal(t, 70.0, p.Data.Inputs.GoalWeightKg)
}

func TestGetPlanSurvivesPaceAboveOnePercent(t *testing.T) {
	e := newPlanEnv(t)
	w := e.do(t, "POST", "/v1/onboarding",
		strings.Replace(planBody(80, `"goal_weight_kg":70,"pace_kg_per_week":0.75`), `"maintenance"`, `"fat_loss"`, 1))
	require.Equal(t, 200, w.Code, w.Body.String())
	e.addWeighIn(t, 70)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.InputError)
	require.NotZero(t, p.Data.Targets.Kcal)
	require.Equal(t, 0.75, p.Data.Inputs.PaceKgPerWeek)
}

func TestPutPlanComparesAgainstLatestWeighIn(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", planBody(73, "")).Code)
	e.addWeighIn(t, 71)
	require.Equal(t, int64(2), e.weighInCount(t))

	require.Equal(t, 200, e.do(t, "PUT", "/v1/me/plan", planBody(71, "")).Code)
	require.Equal(t, int64(2), e.weighInCount(t))
}

// A kcal override and a protein override can each be valid alone yet fail as a
// pair: the protein share limit is taken against the effective kcal.
func TestGetPlanDropsProteinOverrideThatFailsShareAgainstKcalOverride(t *testing.T) {
	e := newPlanEnv(t)
	// Extreme body so a protein figure fits the computed kcal (93) but not the
	// kcal override (78, just over BMR 77.5).
	body := `{"sex":"male","birth_year":1938,"height_cm":50,"weight_kg":20,` +
		`"activity_level":"sedentary","goal":"maintenance"}`
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding", body).Code)
	require.NoError(t, e.db.Exec(`UPDATE users SET target_kcal_override = 78, target_protein_override_g = 16.01 WHERE id = ?`, e.uid).Error)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.OverrideError)
	require.Equal(t, "protein_exceeds_share", *p.Data.OverrideError)
	require.Equal(t, 78.0, p.Data.Targets.Kcal)
	require.NotZero(t, p.Data.Targets.ProteinG)
}

func TestGetPlanFallsBackToProfileWeightForOutOfRangeWeighIn(t *testing.T) {
	e := newPlanEnv(t)
	require.Equal(t, 200, e.do(t, "POST", "/v1/onboarding",
		strings.Replace(planBody(73, `"goal_weight_kg":70,"pace_kg_per_week":0.5`), `"maintenance"`, `"fat_loss"`, 1)).Code)
	e.addWeighIn(t, 5)

	p := e.getPlan(t)
	require.NotNil(t, p.Data.InputError)
	require.NotZero(t, p.Data.Targets.Kcal)
	require.Equal(t, 73.0, p.Data.Inputs.WeightKg)
	require.Equal(t, 70.0, p.Data.Inputs.GoalWeightKg)
}
