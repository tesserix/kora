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
	//
	// The three destination fields are all-or-nothing: a goal weight with no
	// pace (or a pace of 0, or a maintenance goal) is a half-set destination
	// that is neither "no destination" nor a resolved one, so nothing is
	// persisted unless a target date can actually be derived.
	var goalWeightKg, paceKgPerWeek float64
	var targetDate *time.Time
	if in.Goal != "maintenance" && in.GoalWeightKg > 0 && in.PaceKgPerWeek > 0 {
		distance := math.Abs(in.GoalWeightKg - in.WeightKg)
		if distance > 0 {
			// Resolve the user's own timezone so "today" is their calendar
			// day, not the server's UTC one -- a submission before 11:00
			// AEDT is still the previous UTC day, which would otherwise
			// store a target_date one day early.
			loc, err := time.LoadLocation(tz)
			if err != nil {
				loc = time.UTC
			}
			weeks := math.Ceil(distance / in.PaceKgPerWeek)
			today := h.now().In(loc)
			start := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)
			d := start.AddDate(0, 0, int(weeks)*7)
			targetDate = &d
			goalWeightKg = in.GoalWeightKg
			paceKgPerWeek = in.PaceKgPerWeek
		}
	}
	saved, err := h.users.SaveOnboarding(c.Request.Context(), userID, user.OnboardingFields{
		Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
		ActivityLevel: in.ActivityLevel, Goal: in.Goal, Timezone: tz,
		TargetKcal: targets.Kcal, TargetProteinG: targets.ProteinG,
		TargetCarbsG: targets.CarbsG, TargetFatG: targets.FatG,
		GoalWeightKg: goalWeightKg, PaceKgPerWeek: paceKgPerWeek, TargetDate: targetDate,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save onboarding")
		return
	}
	httpx.OK(c, saved)
}
