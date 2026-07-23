package onboarding

import (
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
	uid := c.GetString("uid")
	if uid == "" {
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
	userID, err := h.users.IDByFirebaseUID(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
		return
	}
	saved, err := h.users.SaveOnboarding(c.Request.Context(), userID, user.OnboardingFields{
		Sex: in.Sex, BirthYear: in.BirthYear, HeightCm: in.HeightCm, WeightKg: in.WeightKg,
		ActivityLevel: in.ActivityLevel, Goal: in.Goal,
		TargetKcal: targets.Kcal, TargetProteinG: targets.ProteinG,
		TargetCarbsG: targets.CarbsG, TargetFatG: targets.FatG,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save onboarding")
		return
	}
	httpx.OK(c, saved)
}
