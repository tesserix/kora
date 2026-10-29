package onboarding

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// ottoChange is the model's JSON. Absent fields mean "no change".
type ottoChange struct {
	ActivityLevel    *string  `json:"activity_level"`
	Goal             *string  `json:"goal"`
	GoalWeightKg     *float64 `json:"goal_weight_kg"`
	PaceKgPerWeek    *float64 `json:"pace_kg_per_week"`
	KcalOverride     *float64 `json:"kcal_override"`
	ProteinOverrideG *float64 `json:"protein_override_g"`

	ClearKcalOverride    bool `json:"clear_kcal_override"`
	ClearProteinOverride bool `json:"clear_protein_override"`
}

type ottoReply struct {
	Reply  string      `json:"reply"`
	Change *ottoChange `json:"change"`
}

// PlanChange is one field that differs between the current and proposed plan.
type PlanChange struct {
	Field string `json:"field"` // activity_level|goal|goal_weight_kg|pace_kg_per_week|kcal|protein_g|carbs_g|fat_g
	From  any    `json:"from"`  // string for enums, number rounded to 1 dp (weight/pace) or 0 dp (kcal, grams)
	To    any    `json:"to"`
}

const ottoSystemPrompt = `You are Otto, Kora's nutrition coach, helping a user adjust their daily plan. You receive JSON with the user's message, their current plan inputs, and the targets Kora calculated. Reply with JSON ONLY, no code fences, exactly matching: {"reply": string, "change": object|null}. "reply" is one to three short, warm sentences in plain language. "change" may contain only these keys: "activity_level" (sedentary|light|moderate|active|very_active), "goal" (fat_loss|maintenance|muscle_gain), "goal_weight_kg" (number), "pace_kg_per_week" (number), "kcal_override" (number), "protein_override_g" (number), "clear_kcal_override" (true), "clear_protein_override" (true). Set "change" to null when the message is a question or nothing should change. When the user gives a range from a professional, use its midpoint rounded to a whole number. Never suggest calories below the "bmr" value in the targets. Never give medical advice; suggest a healthcare professional for medical concerns. Kora checks every number you suggest and may refuse it.`

func parseOttoReply(raw string) (ottoReply, error) {
	var r ottoReply
	if err := json.Unmarshal([]byte(stripFence(raw)), &r); err != nil {
		return ottoReply{}, fmt.Errorf("onboarding: otto reply is not JSON: %w", err)
	}
	if strings.TrimSpace(r.Reply) == "" {
		return ottoReply{}, errors.New("onboarding: otto reply is empty")
	}
	return r, nil
}

// apply returns in with the change laid over it. Unknown enum values are
// ignored; Calculate remains the judge of every number.
func (c ottoChange) apply(in Input) Input {
	if c.ActivityLevel != nil {
		if _, ok := activityFactors[*c.ActivityLevel]; ok {
			in.ActivityLevel = *c.ActivityLevel
		}
	}
	if c.Goal != nil && validGoals[*c.Goal] {
		in.Goal = *c.Goal
	}
	if c.GoalWeightKg != nil {
		in.GoalWeightKg = *c.GoalWeightKg
	}
	if c.PaceKgPerWeek != nil {
		in.PaceKgPerWeek = *c.PaceKgPerWeek
	}
	// Maintenance has no destination; leaving the old one would trip
	// Calculate's direction checks on a later switch back.
	if in.Goal == "maintenance" {
		in.GoalWeightKg, in.PaceKgPerWeek = 0, 0
	}
	if c.ClearKcalOverride {
		in.KcalOverride = nil
	}
	if c.KcalOverride != nil {
		in.KcalOverride = c.KcalOverride
	}
	if c.ClearProteinOverride {
		in.ProteinOverrideG = nil
	}
	if c.ProteinOverrideG != nil {
		in.ProteinOverrideG = c.ProteinOverrideG
	}
	return in
}

func (c *ottoChange) empty() bool {
	return c == nil || *c == ottoChange{}
}

func round0(x float64) float64 { return math.Round(x) }
func round1(x float64) float64 { return math.Round(x*10) / 10 }

// planChanges lists only the fields that differ after rounding, so noise
// below the displayed precision never shows up as a change.
func planChanges(oldIn, newIn Input, oldT, newT Targets) []PlanChange {
	var out []PlanChange
	str := func(field, from, to string) {
		if from != to {
			out = append(out, PlanChange{field, from, to})
		}
	}
	num := func(field string, from, to float64, round func(float64) float64) {
		if f, t := round(from), round(to); f != t {
			out = append(out, PlanChange{field, f, t})
		}
	}
	str("activity_level", oldIn.ActivityLevel, newIn.ActivityLevel)
	str("goal", oldIn.Goal, newIn.Goal)
	num("goal_weight_kg", oldIn.GoalWeightKg, newIn.GoalWeightKg, round1)
	num("pace_kg_per_week", oldIn.PaceKgPerWeek, newIn.PaceKgPerWeek, round1)
	num("kcal", oldT.Kcal, newT.Kcal, round0)
	num("protein_g", oldT.ProteinG, newT.ProteinG, round0)
	num("carbs_g", oldT.CarbsG, newT.CarbsG, round0)
	num("fat_g", oldT.FatG, newT.FatG, round0)
	return out
}

// stripFence removes a ```json … ``` wrapper some models add despite being
// told not to. Anything else is left untouched and will fail to unmarshal.
func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
}
