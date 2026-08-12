package onboarding

import (
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	users user.Repository
	now   func() time.Time
}

func NewHandler(users user.Repository) Handler {
	return Handler{users: users, now: time.Now}
}

func (h Handler) Submit(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var in Input
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed onboarding body")
		return
	}
	targets, err := Calculate(in, h.now().Year())
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
		return
	}
	tz := in.Timezone
	if tz == "" {
		tz = user.DefaultTimezone
	}
	// The date is derived, never client-supplied: a client that could post
	// its own target_date could post one the pace does not support.
	var targetDate *time.Time
	if in.Goal != "maintenance" && in.GoalWeightKg > 0 && in.PaceKgPerWeek > 0 {
		distance := math.Abs(in.GoalWeightKg - in.WeightKg)
		if distance > 0 {
			weeks := math.Ceil(distance / in.PaceKgPerWeek)
			d := h.now().AddDate(0, 0, int(weeks)*7)
			targetDate = &d
		}
	}
	saved, err := h.users.SaveOnboarding(c.Request.Context(), userID, user.OnboardingFields{
		Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
		ActivityLevel: in.ActivityLevel, Goal: in.Goal, Timezone: tz,
		TargetKcal: targets.Kcal, TargetProteinG: targets.ProteinG,
		TargetCarbsG: targets.CarbsG, TargetFatG: targets.FatG,
		GoalWeightKg: in.GoalWeightKg, PaceKgPerWeek: in.PaceKgPerWeek, TargetDate: targetDate,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save onboarding")
		return
	}
	httpx.OK(c, saved)
}
