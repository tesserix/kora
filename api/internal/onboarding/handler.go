package onboarding

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/localday"
	"github.com/tesserix/kora/api/internal/tracking"
	"github.com/tesserix/kora/api/internal/user"
)

// WeightRecorder is the subset of tracking.Repository onboarding needs to
// record the user's stated weight as a real weigh-in (kora#45). Declared
// here, not depended on as tracking's concrete Repository, so this package
// only asks for the one write it needs.
type WeightRecorder interface {
	AddWeightEntry(ctx context.Context, userID uuid.UUID, in tracking.WeightInput) (tracking.WeightEntry, error)
}

// onboardingWeighInNamespace derives a deterministic weight_entries.id per
// user (uuid.NewSHA1(namespace, userID)) so a resubmitted or retried
// onboarding call always targets the SAME row instead of inserting a new
// one. It has no meaning beyond being a fixed, never-reused UUID -- it only
// needs to be constant across the process so the derived ID is stable.
var onboardingWeighInNamespace = uuid.MustParse("6a2f9c3e-6b8b-4e0a-9b8a-2f2f6a2b9c31")

type Handler struct {
	users   user.Repository
	weights WeightRecorder
	now     func() time.Time
}

func NewHandler(users user.Repository, weights WeightRecorder) Handler {
	return Handler{users: users, weights: weights, now: time.Now}
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

	// The onboarding weight IS the user's real weight, so it becomes a real
	// weigh-in alongside the profile field -- otherwise the Trends screen's
	// weight card has nothing to show until the user logs one manually,
	// while its "no weigh-ins yet" panel is simultaneously (and correctly)
	// empty. See kora#45 / kora#314.
	//
	// Deliberately NOT part of the SaveOnboarding failure unit: this write
	// is not in the same transaction, and its own failure does not fail the
	// request. A user who cannot complete onboarding because a secondary
	// weigh-in write failed is a far worse outcome than a missing first
	// data point -- the profile weight is still saved, and the weigh-in is
	// simply absent until they log one themselves. Logged and swallowed.
	h.recordFirstWeighIn(c.Request.Context(), userID, in.WeightKg, tz)

	httpx.OK(c, saved)
}

// recordFirstWeighIn writes the onboarding weight as a weight_entries row.
//
// The ID is deterministic per user (uuid.NewSHA1 over a fixed namespace),
// and AddWeightEntry inserts it with ON CONFLICT DO NOTHING keyed on that
// primary key -- so a resubmitted onboarding, or two concurrent submits
// racing each other, both target the same row and only one insert ever
// lands. That is atomic at the database level, unlike a "check for an
// existing entry, then insert" sequence, which two concurrent requests could
// both pass before either had written anything.
func (h Handler) recordFirstWeighIn(ctx context.Context, userID uuid.UUID, weightKg float64, tz string) {
	if h.weights == nil {
		return
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	now := h.now()
	// No client-captured local_date exists for the onboarding payload -- the
	// empty string falls back to the profile zone, exactly as
	// tracking.Handler.AddWeight does for an older client that sends none.
	// See kora#84 and internal/localday.
	localDate, err := localday.Resolve("", now, loc)
	if err != nil {
		slog.WarnContext(ctx, "onboarding: resolve local date for weigh-in failed", "err", err, "user_id", userID)
		return
	}
	id := uuid.NewSHA1(onboardingWeighInNamespace, userID[:])
	_, err = h.weights.AddWeightEntry(ctx, userID, tracking.WeightInput{
		WeightKg:  weightKg,
		LoggedAt:  now,
		LocalDate: localDate,
		Composition: tracking.BodyComposition{
			// Explicit rather than relying on validateComposition's default:
			// an onboarding weight is a stated number, not an instrument
			// reading, and every other composition field stays nil -- a 0
			// here would be a measurement claim Kora never made. See
			// migration 000039 and internal/tracking/model.go.
			Source: tracking.SourceManual,
		},
		ID: id,
	})
	if err != nil {
		slog.WarnContext(ctx, "onboarding: record first weigh-in failed", "err", err, "user_id", userID)
	}
}
