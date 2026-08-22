package coach

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Plan proposal bounds. The planner's JSON is model output, so every field it
// contributes is treated as untrusted length: a card the user has to read and
// approve must stay a card.
const (
	maxPlanDays        = 62
	maxPlanMealsPerDay = 6
	maxPlanSummary     = 600
	maxPlanDateChars   = 40
	maxPlanMealName    = 120
	maxPlanMealDetail  = 400
	// maxPlanMealPreparation is longer than the description: it has to carry
	// enough method to cook from, not a one-line justification.
	maxPlanMealPreparation = 500
	// maxPlanDraftBytes bounds what is even attempted, ahead of parsing. A
	// two-month plan is still bounded; anything past this is not a plan.
	maxPlanDraftBytes = 64 << 10
)

// PlanMeal is one meal in a proposed day.
type PlanMeal struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Preparation is how the meal is actually made. A card without it names
	// food the user cannot cook, so a meal missing it is dropped.
	Preparation string `json:"preparation"`
}

// PlanDay is one day of a proposed plan. Date is the planner's own label
// ("Monday", "2026-08-25") and is displayed verbatim rather than parsed —
// Kora does not schedule from it.
type PlanDay struct {
	Date  string     `json:"date"`
	Meals []PlanMeal `json:"meals"`
}

// PlanDays is the JSONB column holding a proposal's days.
type PlanDays []PlanDay

func (d PlanDays) Value() (driver.Value, error) {
	raw, err := json.Marshal([]PlanDay(d))
	if err != nil {
		return nil, fmt.Errorf("coach: encode plan days: %w", err)
	}
	return string(raw), nil
}

func (d *PlanDays) Scan(src any) error {
	var raw []byte
	switch value := src.(type) {
	case nil:
		*d = nil
		return nil
	case []byte:
		raw = value
	case string:
		raw = []byte(value)
	default:
		return fmt.Errorf("coach: decode plan days: unsupported type %T", src)
	}
	return json.Unmarshal(raw, (*[]PlanDay)(d))
}

// PlanProposal is a reviewed meal plan the user has yet to approve. It is the
// planner's structured draft, kept structured: the reviewed prose says why the
// plan fits, and this says what the plan IS, so the client can render a card
// with an approve action instead of asking the user to parse a paragraph.
//
// Approval activates the plan's finite reminder projection. It still does not
// log meals into the diary; logging remains an explicit user action.
type PlanProposal struct {
	ID          uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID      uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	CoachTurnID uuid.UUID  `gorm:"type:uuid;not null;uniqueIndex" json:"-"`
	Summary     string     `json:"summary"`
	Days        PlanDays   `gorm:"type:jsonb;not null" json:"days"`
	AgentName   string     `json:"agent_name"`
	ReviewedBy  string     `json:"reviewed_by"`
	AcceptedAt  *time.Time `json:"accepted_at"`
	// StartsOn is the user's local calendar date on the day they approved the
	// plan, and Timezone is the zone that date was read in. Both are written
	// once, at acceptance: a plan the user approves tonight starts on the day
	// they are living in, not on a UTC date that may already be tomorrow.
	StartsOn  *time.Time `gorm:"type:date" json:"starts_on"`
	Timezone  string     `json:"timezone"`
	CreatedAt time.Time  `json:"created_at"`
}

func (PlanProposal) TableName() string { return "coach_plan_proposals" }

// ErrPlanNotFound is returned when a plan proposal does not exist, or exists
// but belongs to another user — the two are deliberately indistinguishable to
// the caller, so an id probe cannot confirm someone else's plan.
var ErrPlanNotFound = errors.New("coach: plan proposal not found")

// newPlanProposal builds a proposal from a planner envelope, or returns nil
// when there is nothing worth showing as a card. A nil result is normal: most
// drafts that reach here are prose, and the thread still renders them.
func newPlanProposal(userID uuid.UUID, plan planEnvelope, agentName, reviewedBy string) *PlanProposal {
	days := make(PlanDays, 0, len(plan.Days))
	for _, day := range plan.Days {
		meals := make([]PlanMeal, 0, len(day.Meals))
		for _, meal := range day.Meals {
			name := clampPlanText(meal.Name, maxPlanMealName)
			preparation := clampPlanText(meal.Preparation, maxPlanMealPreparation)
			if name == "" || preparation == "" {
				continue
			}
			meals = append(meals, PlanMeal{
				Name:        name,
				Description: clampPlanText(meal.Description, maxPlanMealDetail),
				Preparation: preparation,
			})
			if len(meals) == maxPlanMealsPerDay {
				break
			}
		}
		if len(meals) == 0 {
			continue
		}
		days = append(days, PlanDay{Date: clampPlanText(day.Date, maxPlanDateChars), Meals: meals})
		if len(days) == maxPlanDays {
			break
		}
	}
	if len(days) == 0 {
		return nil
	}

	agentName = clampPlanText(agentName, 120)
	if agentName == "" {
		agentName = fallbackAgentName
	}
	reviewedBy = clampPlanText(reviewedBy, 120)
	if reviewedBy == "" {
		reviewedBy = fallbackAgentName
	}
	return &PlanProposal{
		UserID:     userID,
		Summary:    clampPlanText(plan.Summary, maxPlanSummary),
		Days:       days,
		AgentName:  agentName,
		ReviewedBy: reviewedBy,
	}
}

// clampPlanText trims a model-supplied string and truncates it on a rune
// boundary, so a long field shortens the card rather than breaking the
// column's length check or the UTF-8 in it.
func clampPlanText(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return strings.TrimSpace(string(runes[:max]))
}
