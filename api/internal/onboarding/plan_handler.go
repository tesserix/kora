package onboarding

import (
	"context"
	"errors"
	"math"
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
	weight, err := h.currentWeight(ctx, u)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load plan")
		return
	}
	in := Input{
		Sex: u.Sex, BirthYear: u.BirthYear, HeightCm: u.HeightCm, WeightKg: weight,
		ActivityLevel: u.ActivityLevel, Goal: u.Goal, Timezone: u.Timezone,
		GoalWeightKg: u.GoalWeightKg, PaceKgPerWeek: u.PaceKgPerWeek,
		KcalOverride: u.TargetKcalOverride, ProteinOverrideG: u.TargetProteinOverrideG,
	}

	year := h.now().Year()
	calc := in
	// A newer weight can break the stored destination (pace over 1% of
	// bodyweight, goal already reached); the plan still has to load, so
	// compute without the destination and say why in input_error.
	var inputErr *string
	if _, err := Calculate(Input{Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
		ActivityLevel: in.ActivityLevel, Goal: in.Goal, GoalWeightKg: in.GoalWeightKg, PaceKgPerWeek: in.PaceKgPerWeek}, year); err != nil {
		msg := err.Error()
		inputErr = &msg
		calc.GoalWeightKg = 0
		calc.PaceKgPerWeek = math.Min(calc.PaceKgPerWeek, in.WeightKg*maxPaceFractionOfBodyweight)
	}

	// Check each override against the full (fallback-applied) input and drop
	// only the ones that fail, so a valid one survives; the first failing
	// code (kcal, then protein) is reported.
	var overrideErr *string
	withOnly := func(k, p *float64) Input { x := calc; x.KcalOverride, x.ProteinOverrideG = k, p; return x }
	if in.KcalOverride != nil {
		if _, err := Calculate(withOnly(in.KcalOverride, nil), year); err != nil {
			calc.KcalOverride = nil
			overrideErr = overrideCode(err, overrideErr)
		}
	}
	if in.ProteinOverrideG != nil {
		if _, err := Calculate(withOnly(nil, in.ProteinOverrideG), year); err != nil {
			calc.ProteinOverrideG = nil
			overrideErr = overrideCode(err, overrideErr)
		}
	}
	targets, err := Calculate(calc, year)
	// Each override passed alone but the pair can still fail (the protein share
	// check uses the effective kcal): drop protein first, then kcal.
	var oe *OverrideError
	for _, drop := range []func(){func() { calc.ProteinOverrideG = nil }, func() { calc.KcalOverride = nil }} {
		if !errors.As(err, &oe) {
			break
		}
		if overrideErr == nil {
			overrideErr = &oe.Code
		}
		drop()
		targets, err = Calculate(calc, year)
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not compute plan")
		return
	}

	// Echo the stored overrides, not the retried ones.
	in.KcalOverride, in.ProteinOverrideG = u.TargetKcalOverride, u.TargetProteinOverrideG
	httpx.OK(c, gin.H{"inputs": in, "targets": targets, "override_error": overrideErr, "input_error": inputErr})
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
	// Compare with the weight GET reports (latest weigh-in), not users.weight_kg,
	// or the first save after any tracked weigh-in would log a duplicate.
	prev, _ := h.currentWeight(ctx, current) // falls back to the profile weight on error
	if d := in.WeightKg - prev; d >= weightChangeEpsilonKg || d <= -weightChangeEpsilonKg {
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

// currentWeight is the latest weigh-in, falling back to the profile weight.
func (h Handler) currentWeight(ctx context.Context, u user.User) (float64, error) {
	if h.weights == nil {
		return u.WeightKg, nil
	}
	kg, found, err := h.weights.LatestWeightKg(ctx, u.ID)
	if err != nil || !found {
		return u.WeightKg, err
	}
	return kg, nil
}
