package onboarding

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// weightChangeEpsilonKg is the smallest difference that counts as a new
// weight; below it the PUT is an edit of something else.
const weightChangeEpsilonKg = 0.05

// GetPlan returns the inputs behind the user's plan and the targets they give
// today. The weight is the latest weigh-in, so the plan follows the user's
// body; a stored override the new weight invalidates is reported in
// override_error and left in the database.
func (h Handler) GetPlan(c *gin.Context) {
	ctx := c.Request.Context()
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	u, err := h.users.ByID(ctx, userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load plan")
		return
	}
	if u.OnboardedAt == nil {
		httpx.Error(c, http.StatusConflict, "not_onboarded", "onboarding is not complete")
		return
	}
	weight := u.WeightKg
	if h.weights != nil {
		kg, found, err := h.weights.LatestWeightKg(ctx, userID)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load plan")
			return
		}
		if found {
			weight = kg
		}
	}
	in := Input{
		Sex: u.Sex, BirthYear: u.BirthYear, HeightCm: u.HeightCm, WeightKg: weight,
		ActivityLevel: u.ActivityLevel, Goal: u.Goal, Timezone: u.Timezone,
		GoalWeightKg: u.GoalWeightKg, PaceKgPerWeek: u.PaceKgPerWeek,
		KcalOverride: u.TargetKcalOverride, ProteinOverrideG: u.TargetProteinOverrideG,
	}

	// Check each override on its own and drop only the ones that fail, so a
	// valid one survives; the first failing code (kcal, then protein) is reported.
	year := h.now().Year()
	var overrideErr *string
	checked := in
	if in.KcalOverride != nil {
		if _, err := Calculate(Input{Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
			ActivityLevel: in.ActivityLevel, Goal: in.Goal, GoalWeightKg: in.GoalWeightKg, KcalOverride: in.KcalOverride}, year); err != nil {
			checked.KcalOverride = nil
			overrideErr = overrideCode(err, overrideErr)
		}
	}
	if in.ProteinOverrideG != nil {
		if _, err := Calculate(Input{Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
			ActivityLevel: in.ActivityLevel, Goal: in.Goal, GoalWeightKg: in.GoalWeightKg, ProteinOverrideG: in.ProteinOverrideG}, year); err != nil {
			checked.ProteinOverrideG = nil
			overrideErr = overrideCode(err, overrideErr)
		}
	}
	targets, err := Calculate(checked, year)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not compute plan")
		return
	}

	// Echo the stored overrides, not the retried ones.
	in.KcalOverride, in.ProteinOverrideG = u.TargetKcalOverride, u.TargetProteinOverrideG
	httpx.OK(c, gin.H{"inputs": in, "targets": targets, "override_error": overrideErr})
}

// PutPlan re-saves the plan from the same body as POST /v1/onboarding. It
// never touches onboarded_at, and a changed weight becomes a new weigh-in.
func (h Handler) PutPlan(c *gin.Context) {
	ctx := c.Request.Context()
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var in Input
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed plan body")
		return
	}
	current, err := h.users.ByID(ctx, userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save plan")
		return
	}
	if current.OnboardedAt == nil {
		httpx.Error(c, http.StatusConflict, "not_onboarded", "onboarding is not complete")
		return
	}
	fields, herr := h.resolve(ctx, in)
	if herr != nil {
		herr.write(c)
		return
	}
	saved, err := h.users.SavePlan(ctx, userID, fields)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save plan")
		return
	}
	if d := in.WeightKg - current.WeightKg; d >= weightChangeEpsilonKg || d <= -weightChangeEpsilonKg {
		// Same isolation as Submit: the plan is saved, a failed weigh-in is logged.
		h.recordWeighIn(ctx, userID, in.WeightKg, fields.Timezone, uuid.Nil)
	}
	httpx.OK(c, saved)
}

// overrideCode returns first if set, else the code inside err.
func overrideCode(err error, first *string) *string {
	var oe *OverrideError
	if first != nil || !errors.As(err, &oe) {
		return first
	}
	return &oe.Code
}
