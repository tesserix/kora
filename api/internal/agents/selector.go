package agents

import (
	"context"
	"strings"
)

// Name is a reviewed Kora agent exposed through AgentGateway.
type Name string

// Selector chooses which agent answers a question. *Registry is the production
// implementation, routing on skills the registry publishes; KeywordSelector is
// the fallback when no registry is configured.
type Selector interface {
	SelectForQuestion(ctx context.Context, question string) Name
}

// KeywordSelector routes with the compiled-in phrase table. It is the floor
// every other selector falls back to, so it must never depend on the network.
type KeywordSelector struct{}

func (KeywordSelector) SelectForQuestion(_ context.Context, question string) Name {
	return SelectForQuestion(question)
}

const (
	NutritionCoach Name = "nutrition-coach"
	MealPlanner    Name = "meal-planner"
)

// SelectForQuestion keeps supervisor routing deterministic and reviewable.
func SelectForQuestion(question string) Name {
	normalized := strings.ToLower(strings.Join(strings.Fields(question), " "))
	mealPlanningPhrases := []string{
		"meal plan",
		"plan meals",
		"plan my meals",
		"weekly menu",
		"plan my menu",
	}
	for _, phrase := range mealPlanningPhrases {
		if strings.Contains(normalized, phrase) {
			return MealPlanner
		}
	}
	return NutritionCoach
}

func (n Name) reviewed() bool {
	return n == NutritionCoach || n == MealPlanner
}

// RosterSource supplies the set of agents a trusted control plane currently
// publishes, widening the compiled-in allowlist without ever letting request
// data name an agent.
type RosterSource interface {
	Roster(ctx context.Context) func(Name) bool
}
